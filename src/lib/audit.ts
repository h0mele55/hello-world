import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '@/generated/prisma/client';
import { strictCanonicalJson } from './canonical-json';

/**
 * The internal audit log: append-only and hash-chained per organisation.
 *
 *   hash = SHA-256(prevHash bytes || UTF-8 of the canonical JSON of the event)
 *
 * The first event of an organisation chains from GENESIS_HASH. A trigger in the
 * migration refuses UPDATE and DELETE, so an edit can only be made by a
 * database owner, and `verifyAuditChain` then finds it: changing any event, or
 * removing one, breaks every hash after it.
 *
 * Event data names ids, hashes, statuses and reason codes, never a client
 * name, an opinion or a manifest (CLAUDE.md: never log confidential data).
 */

export const AUDIT_EVENT_VERSION = 1;
export const GENESIS_HASH = `0x${'0'.repeat(64)}`;

/**
 * Advisory locks use the two-integer key space, whose first key names what is
 * locked, so an audit append can never wait on a worker's issuer lock.
 */
export const ADVISORY_LOCK_CLASS = { AUDIT: 1, ISSUER_KEY: 2 } as const;

export type AuditAction =
  | 'engagement.created'
  | 'version.uploaded'
  | 'version.confirmed'
  | 'version.discarded'
  | 'version.approved'
  | 'chain_mode.changed'
  | 'anchor.simulated'
  | 'anchor.linked'
  | 'anchor.broadcast'
  | 'anchor.replaced'
  | 'anchor.indeterminate'
  | 'anchor.final'
  | 'anchor.failed'
  | 'anchor.copy_requeued'
  | 'anchor.nonce_released'
  | 'version.stamped'
  | 'version.certified'
  | 'mfa.enabled'
  | 'mfa.recovery_code_used'
  | 'revocation.requested'
  | 'revocation.approved'
  | 'revocation.rejected'
  | 'revocation.withdrawn'
  | 'revocation.scheduled'
  | 'revocation.in_effect'
  | 'revocation.cancelled'
  | 'registry_watch.unjournaled'
  | 'registry_watch.reviewed'
  | 'recipient.added'
  | 'recipient.removed'
  | 'notification.queued'
  | 'notification.sent'
  | 'notification.failed'
  // The OpenTimestamps job (#66).
  | 'ots.submitted'
  | 'ots.complete'
  | 'ots.broken'
  // An audit-log head's journal row (#94): the anchor.* steps under their own prefix, and the check that queued it.
  | 'audit_head.queued'
  | 'audit_head.simulated'
  | 'audit_head.broadcast'
  | 'audit_head.replaced'
  | 'audit_head.indeterminate'
  | 'audit_head.final'
  | 'audit_head.failed'
  | 'audit_head.nonce_released';

export interface AuditEventInput {
  orgId: string;
  /** The user, or null for the worker. */
  actorId: string | null;
  action: AuditAction;
  subjectType: 'Engagement' | 'ReportVersion' | 'IssuerOrg' | 'ChainWrite' | 'User' | 'Revocation' | 'Recipient' | 'Notification' | 'UnjournaledWrite';
  subjectId: string;
  /** Plain JSON only: strings, safe integers, booleans, null, arrays and objects. */
  data: Record<string, unknown>;
}

interface StoredEvent {
  orgId: string;
  seq: number;
  at: string;
  actorId: string | null;
  action: string;
  subjectType: string;
  subjectId: string;
  data: unknown;
  prevHash: string;
  hash: string;
}

export function auditHashOf(prevHash: string, event: Omit<StoredEvent, 'prevHash' | 'hash'>): string {
  const body = strictCanonicalJson({
    v: AUDIT_EVENT_VERSION,
    orgId: event.orgId,
    seq: event.seq,
    at: event.at,
    actorId: event.actorId,
    action: event.action,
    subjectType: event.subjectType,
    subjectId: event.subjectId,
    data: event.data,
  });
  const digest = createHash('sha256').update(Buffer.from(prevHash.slice(2), 'hex')).update(body, 'utf8').digest('hex');
  return `0x${digest}`;
}

/**
 * Appends one event inside the caller's transaction, so the event commits if
 * and only if the change it records does. A transaction-scoped advisory lock
 * per organisation serialises appends, so two writers never chain from the
 * same predecessor.
 */
export async function appendAuditEvent(tx: Prisma.TransactionClient, input: AuditEventInput, now: Date = new Date()) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ADVISORY_LOCK_CLASS.AUDIT}::int, hashtext(${input.orgId}))`;
  const last = await tx.auditEvent.findFirst({ where: { orgId: input.orgId }, orderBy: { seq: 'desc' }, select: { seq: true, hash: true } });
  const event = {
    orgId: input.orgId,
    seq: (last?.seq ?? 0) + 1,
    at: now.toISOString(),
    actorId: input.actorId,
    action: input.action,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    data: input.data,
  };
  const prevHash = last?.hash ?? GENESIS_HASH;
  const hash = auditHashOf(prevHash, event);
  return tx.auditEvent.create({ data: { ...event, data: input.data as Prisma.InputJsonObject, prevHash, hash } });
}

export type AuditChainResult =
  | { ok: true; count: number; head: string }
  | { ok: false; seq: number; reason: 'SEQ_GAP' | 'PREV_HASH_MISMATCH' | 'HASH_MISMATCH' };

/** Re-derives every hash of an organisation's chain, in order. */
export async function verifyAuditChain(client: PrismaClient | Prisma.TransactionClient, orgId: string): Promise<AuditChainResult> {
  let prevHash = GENESIS_HASH;
  let expectedSeq = 1;
  for (;;) {
    // Paged by seq: a gap shows up as the first row of the next page having
    // the wrong number, not as a skipped page.
    const page: StoredEvent[] = await client.auditEvent.findMany({
      where: { orgId, seq: { gte: expectedSeq } },
      orderBy: { seq: 'asc' },
      take: 500,
      select: { orgId: true, seq: true, at: true, actorId: true, action: true, subjectType: true, subjectId: true, data: true, prevHash: true, hash: true },
    });
    for (const event of page) {
      if (event.seq !== expectedSeq) return { ok: false, seq: event.seq, reason: 'SEQ_GAP' };
      if (event.prevHash !== prevHash) return { ok: false, seq: event.seq, reason: 'PREV_HASH_MISMATCH' };
      if (auditHashOf(prevHash, event) !== event.hash) return { ok: false, seq: event.seq, reason: 'HASH_MISMATCH' };
      prevHash = event.hash;
      expectedSeq++;
    }
    if (page.length < 500) break;
  }
  return { ok: true, count: expectedSeq - 1, head: prevHash };
}
