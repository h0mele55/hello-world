import 'server-only';
import type { SessionUser } from '@/auth';
import { Prisma } from '@/generated/prisma/client';
import type { ChainWriteMode } from '@/generated/prisma/enums';
import { appendAuditEvent } from '@/lib/audit';
import { db } from '@/lib/db';
import { requireRole } from '@/lib/roles';
import { AnchoringError } from './errors';
import { MODE_LADDER, rungOf } from './ladder';
import type { AnchorTarget } from './target';

/**
 * The human side of anchoring: the organisation's write mode and the second
 * person's approval. Approval writes the journal's INTENT row; only the worker
 * (src/lib/anchoring/worker.ts) talks to a chain.
 */

function requireApprover(user: SessionUser) {
  requireRole(user, 'approve');
}

/**
 * Locks the organisation row, so the mode cannot change under an approval in
 * flight. FOR NO KEY UPDATE, not FOR UPDATE: every audited write takes the
 * firm's audit lock and then inserts rows whose foreign key reaches this row,
 * which takes a key-share lock that FOR UPDATE would block. An approval holds
 * this row and then asks for the audit lock, so the two would deadlock.
 */
export async function lockOrg(tx: Prisma.TransactionClient, orgId: string): Promise<ChainWriteMode> {
  const rows = await tx.$queryRaw<{ chainWriteMode: ChainWriteMode }[]>`SELECT "chainWriteMode" FROM "IssuerOrg" WHERE id = ${orgId} FOR NO KEY UPDATE`;
  if (rows.length !== 1) throw new AnchoringError('NOT_FOUND');
  return rows[0].chainWriteMode;
}

export async function getChainWriteMode(user: SessionUser): Promise<ChainWriteMode> {
  const org = await db().issuerOrg.findUnique({ where: { id: user.orgId }, select: { chainWriteMode: true } });
  if (!org) throw new AnchoringError('NOT_FOUND');
  return org.chainWriteMode;
}

export async function setChainWriteMode(user: SessionUser, mode: ChainWriteMode) {
  requireRole(user, 'setChainMode');
  if (!MODE_LADDER.includes(mode)) throw new AnchoringError('MODE_SKIPS_RUNG');
  return db().$transaction(async (tx) => {
    const from = await lockOrg(tx, user.orgId);
    if (from === mode) throw new AnchoringError('MODE_UNCHANGED');
    if (rungOf(mode) > rungOf(from) + 1) throw new AnchoringError('MODE_SKIPS_RUNG', `${from} widens to ${MODE_LADDER[rungOf(from) + 1]} first`);
    await tx.issuerOrg.update({ where: { id: user.orgId }, data: { chainWriteMode: mode } });
    await appendAuditEvent(tx, {
      orgId: user.orgId,
      actorId: user.id,
      action: 'chain_mode.changed',
      subjectType: 'IssuerOrg',
      subjectId: user.orgId,
      data: { from, to: mode },
    });
    return { from, to: mode };
  });
}

/**
 * The second person approves a confirmed version (CLAUDE.md rule 6), which
 * queues its anchor: the version becomes APPROVED and an INTENT row is written
 * in the same transaction, before anything is sent (rule 3). The approver is
 * neither the preparer nor the confirmer; a CHECK in the database holds that
 * too. Version n > 1 waits until version n − 1 is anchored, because its parent
 * must be the family's latest record.
 */
export async function approveVersion(user: SessionUser, versionId: string, target: AnchorTarget | null) {
  requireApprover(user);
  if (!target) throw new AnchoringError('CHAIN_NOT_CONFIGURED');
  return db().$transaction(async (tx) => {
    const mode = await lockOrg(tx, user.orgId);
    if (mode === 'DISABLED') throw new AnchoringError('CHAIN_WRITES_DISABLED');
    const version = await tx.reportVersion.findFirst({
      where: { id: versionId, engagement: { client: { orgId: user.orgId } } },
      select: { id: true, engagementId: true, version: true, status: true, docHash: true, preparedById: true, confirmedById: true },
    });
    if (!version) throw new AnchoringError('NOT_FOUND');
    if (version.status !== 'CONFIRMED') throw new AnchoringError('NOT_CONFIRMED');
    if (version.preparedById === user.id || version.confirmedById === user.id) throw new AnchoringError('FOUR_EYES');
    if (version.version > 1) {
      const predecessor = await tx.reportVersion.findUnique({
        where: { engagementId_version: { engagementId: version.engagementId, version: version.version - 1 } },
        select: { status: true, recordId: true },
      });
      if (!predecessor?.recordId || (predecessor.status !== 'ANCHORED' && predecessor.status !== 'COMPLETE')) {
        throw new AnchoringError('PREDECESSOR_NOT_ANCHORED');
      }
    }

    const approvedAt = new Date();
    const { count } = await tx.reportVersion.updateMany({
      where: { id: version.id, status: 'CONFIRMED' },
      data: { status: 'APPROVED', approvedById: user.id, approvedAt },
    });
    if (count !== 1) throw new AnchoringError('NOT_CONFIRMED');
    let write;
    try {
      write = await tx.chainWrite.create({
        data: { reportVersionId: version.id, kind: 'ANCHOR', mode, chainId: target.chainId, registry: target.registry, issuer: target.issuer },
        select: { id: true },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new AnchoringError('ALREADY_QUEUED');
      throw error;
    }
    await appendAuditEvent(tx, {
      orgId: user.orgId,
      actorId: user.id,
      action: 'version.approved',
      subjectType: 'ReportVersion',
      subjectId: version.id,
      data: { chainWriteId: write.id, mode, docHash: version.docHash, chainId: target.chainId, registry: target.registry, issuer: target.issuer },
    });
    return { chainWriteId: write.id, mode };
  });
}

/**
 * Queues the distribution copy again after its write failed (for example a
 * stamp that did not pass its check, or a mode narrowed before it was sent).
 * The version's approval already covers its copy, so this needs an approver
 * but not a second approval; it is LIVE only, since the original is on chain.
 */
export async function requeueCopy(user: SessionUser, versionId: string, target: AnchorTarget | null) {
  requireApprover(user);
  if (!target) throw new AnchoringError('CHAIN_NOT_CONFIGURED');
  return db().$transaction(async (tx) => {
    const mode = await lockOrg(tx, user.orgId);
    if (mode !== 'LIVE') throw new AnchoringError('CHAIN_WRITES_DISABLED', 'a distribution copy is anchored only in LIVE');
    const version = await tx.reportVersion.findFirst({
      where: { id: versionId, engagement: { client: { orgId: user.orgId } } },
      select: { id: true, status: true, anchorOnly: true },
    });
    if (!version) throw new AnchoringError('NOT_FOUND');
    if (version.anchorOnly) throw new AnchoringError('ANCHOR_ONLY');
    if (version.status !== 'ANCHORED') throw new AnchoringError('NOT_ANCHORED');
    let write;
    try {
      write = await tx.chainWrite.create({
        data: { reportVersionId: version.id, kind: 'ANCHOR_COPY', mode, chainId: target.chainId, registry: target.registry, issuer: target.issuer },
        select: { id: true },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new AnchoringError('ALREADY_QUEUED');
      throw error;
    }
    await appendAuditEvent(tx, {
      orgId: user.orgId,
      actorId: user.id,
      action: 'anchor.copy_requeued',
      subjectType: 'ReportVersion',
      subjectId: version.id,
      data: { chainWriteId: write.id },
    });
    return { chainWriteId: write.id };
  });
}
