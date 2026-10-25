import 'server-only';
import { randomUUID } from 'node:crypto';
import type { SessionUser } from '@/auth';
import { Prisma } from '@/generated/prisma/client';
import type { RevocationReason } from '@/generated/prisma/enums';
import { appendAuditEvent } from '@/lib/audit';
import { db } from '@/lib/db';
import { currentSealingKey, sealingKeys } from '@/lib/keys';
import { REVOCATION_CODES } from '@/lib/revocation-reasons';
import { requireRole } from '@/lib/roles';
import { open, seal } from '@/lib/sealed';
import { lockOrg } from './approve';
import { AnchoringError } from './errors';
import type { AnchorTarget } from './target';

/**
 * Withdrawing an anchored version (Phase 5, #55). An admin asks, naming the
 * engagement to show they mean it, with a reason and a note; an approver who
 * is someone else approves (rule 6), which writes the REVOKE row to the
 * journal in the same transaction (rule 3). Only the worker sends it. Once
 * that write's block is final the revocation is SCHEDULED: the registry
 * delays it (#95), and the registry's owner may cancel it until then. The
 * version is REVOKED once the revocation is in effect at a final block (rule
 * 2), or the revocation is CANCELLED if the owner cancelled it.
 *
 * The note is sealed and never leaves the database: the chain gets the
 * reason's number and nothing else (rule 1).
 */

const noteContext = (revocationId: string) => `revocation:${revocationId}:note`;
const REVOCABLE = ['ANCHORED', 'COMPLETE'] as const;

export interface RevocationRequest {
  versionId: string;
  reason: RevocationReason;
  note: string;
  /** The engagement's reference, typed by the admin. */
  confirmation: string;
}

const isUniqueViolation = (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

export async function requestRevocation(user: SessionUser, input: RevocationRequest) {
  requireRole(user, 'requestRevocation');
  return db().$transaction(async (tx) => {
    const version = await tx.reportVersion.findFirst({
      where: { id: input.versionId, engagement: { client: { orgId: user.orgId } } },
      select: { id: true, status: true, recordId: true, engagement: { select: { engagementRef: true } } },
    });
    if (!version) throw new AnchoringError('NOT_FOUND');
    if (!(REVOCABLE as readonly string[]).includes(version.status) || !version.recordId) throw new AnchoringError('NOT_REVOCABLE');
    if (input.confirmation.trim() !== version.engagement.engagementRef) throw new AnchoringError('CONFIRMATION_MISMATCH');
    const id = randomUUID();
    try {
      await tx.revocation.create({
        data: {
          id,
          reportVersionId: version.id,
          reason: input.reason,
          note: seal(currentSealingKey(), new TextEncoder().encode(input.note.trim()), noteContext(id)),
          requestedById: user.id,
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new AnchoringError('REVOCATION_OPEN');
      throw error;
    }
    await appendAuditEvent(tx, {
      orgId: user.orgId,
      actorId: user.id,
      action: 'revocation.requested',
      subjectType: 'Revocation',
      subjectId: id,
      data: { reportVersionId: version.id, reason: input.reason, code: REVOCATION_CODES[input.reason] },
    });
    return { revocationId: id };
  });
}

/** Reads a request of the caller's firm, locked for the rest of the transaction. */
async function lockRevocation(tx: Prisma.TransactionClient, user: SessionUser, revocationId: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT r."id" FROM "Revocation" r
    JOIN "ReportVersion" v ON v."id" = r."reportVersionId"
    JOIN "Engagement" e ON e."id" = v."engagementId"
    JOIN "Client" c ON c."id" = e."clientId"
    WHERE r."id" = ${revocationId} AND c."orgId" = ${user.orgId}
    FOR NO KEY UPDATE OF r`;
  if (rows.length !== 1) throw new AnchoringError('NOT_FOUND');
  return tx.revocation.findUniqueOrThrow({
    where: { id: revocationId },
    include: { reportVersion: { select: { id: true, status: true, recordId: true } } },
  });
}

/**
 * The second person approves (rule 6): never the admin who asked, which a
 * CHECK in the database holds too. The REVOKE write is queued in the firm's
 * current mode; a dry run only simulates it and returns the request for
 * approval. A stamped copy still on its way to the chain is let finish first.
 */
export async function approveRevocation(user: SessionUser, revocationId: string, target: AnchorTarget | null) {
  requireRole(user, 'approve');
  if (!target) throw new AnchoringError('CHAIN_NOT_CONFIGURED');
  return db().$transaction(async (tx) => {
    const mode = await lockOrg(tx, user.orgId);
    if (mode === 'DISABLED') throw new AnchoringError('CHAIN_WRITES_DISABLED');
    const revocation = await lockRevocation(tx, user, revocationId);
    if (revocation.status !== 'REQUESTED') throw new AnchoringError('NOT_REQUESTED');
    if (revocation.requestedById === user.id) throw new AnchoringError('FOUR_EYES');
    const version = revocation.reportVersion;
    if (!(REVOCABLE as readonly string[]).includes(version.status) || !version.recordId) throw new AnchoringError('NOT_REVOCABLE');
    const copyInFlight = await tx.chainWrite.count({
      where: { reportVersionId: version.id, kind: 'ANCHOR_COPY', status: { in: ['INTENT', 'BROADCAST', 'INDETERMINATE'] } },
    });
    if (copyInFlight > 0) throw new AnchoringError('COPY_IN_FLIGHT');

    await tx.revocation.update({ where: { id: revocation.id }, data: { status: 'APPROVED', approvedById: user.id, approvedAt: new Date() } });
    let write;
    try {
      write = await tx.chainWrite.create({
        data: { orgId: user.orgId, reportVersionId: version.id, kind: 'REVOKE', mode, chainId: target.chainId, registry: target.registry, issuer: target.issuer, recordId: version.recordId },
        select: { id: true },
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new AnchoringError('ALREADY_QUEUED');
      throw error;
    }
    await appendAuditEvent(tx, {
      orgId: user.orgId,
      actorId: user.id,
      action: 'revocation.approved',
      subjectType: 'Revocation',
      subjectId: revocation.id,
      data: { reportVersionId: version.id, chainWriteId: write.id, mode, recordId: version.recordId, code: REVOCATION_CODES[revocation.reason] },
    });
    return { chainWriteId: write.id, mode };
  });
}

/** An approver turns a request down, or the admin who made it takes it back. Either closes it before anything is queued. */
async function closeRevocation(user: SessionUser, revocationId: string, as: 'REJECTED' | 'WITHDRAWN') {
  requireRole(user, as === 'REJECTED' ? 'approve' : 'requestRevocation');
  return db().$transaction(async (tx) => {
    const revocation = await lockRevocation(tx, user, revocationId);
    if (revocation.status !== 'REQUESTED') throw new AnchoringError('NOT_REQUESTED');
    // Only the admin who asked may take a request back.
    if (as === 'WITHDRAWN' && revocation.requestedById !== user.id) throw new AnchoringError('NOT_FOUND');
    await tx.revocation.update({ where: { id: revocation.id }, data: { status: as, closedById: user.id, closedAt: new Date() } });
    await appendAuditEvent(tx, {
      orgId: user.orgId,
      actorId: user.id,
      action: as === 'REJECTED' ? 'revocation.rejected' : 'revocation.withdrawn',
      subjectType: 'Revocation',
      subjectId: revocation.id,
      data: { reportVersionId: revocation.reportVersionId },
    });
    return { status: as };
  });
}

export const rejectRevocation = (user: SessionUser, revocationId: string) => closeRevocation(user, revocationId, 'REJECTED');
export const withdrawRevocation = (user: SessionUser, revocationId: string) => closeRevocation(user, revocationId, 'WITHDRAWN');

/** A version's revocation requests, newest first, with their notes opened. Scoped to the caller's firm. */
export async function getRevocations(user: SessionUser, versionId: string) {
  const rows = await db().revocation.findMany({
    where: { reportVersionId: versionId, reportVersion: { engagement: { client: { orgId: user.orgId } } } },
    orderBy: { requestedAt: 'desc' },
    take: 20,
    include: {
      requestedBy: { select: { email: true } },
      approvedBy: { select: { email: true } },
      closedBy: { select: { email: true } },
    },
  });
  const keys = sealingKeys();
  return rows.map((r) => ({
    id: r.id,
    reason: r.reason,
    code: REVOCATION_CODES[r.reason],
    note: new TextDecoder().decode(open(keys, r.note, noteContext(r.id))),
    status: r.status,
    requestedById: r.requestedById,
    requestedBy: r.requestedBy.email,
    requestedAt: r.requestedAt.toISOString(),
    approvedBy: r.approvedBy?.email ?? null,
    approvedAt: r.approvedAt?.toISOString() ?? null,
    closedBy: r.closedBy?.email ?? null,
    closedAt: r.closedAt?.toISOString() ?? null,
    effectiveAt: r.effectiveAt?.toISOString() ?? null,
    revokedAt: r.revokedAt?.toISOString() ?? null,
  }));
}

export type RevocationView = Awaited<ReturnType<typeof getRevocations>>[number];
