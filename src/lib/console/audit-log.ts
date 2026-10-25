import 'server-only';
import type { SessionUser } from '@/auth';
import { verifyAuditChain } from '@/lib/audit';
import { db } from '@/lib/db';

/** The audit log as the console shows it: newest first, a page at a time, the firm's own events only. */

export const AUDIT_PAGE_SIZE = 50;
/** The check runs nightly; one older than this means it has stopped running. */
export const AUDIT_CHECK_STALE_MS = 36 * 60 * 60 * 1000;

export async function listAuditEvents(user: SessionUser, before?: number) {
  const events = await db().auditEvent.findMany({
    where: { orgId: user.orgId, ...(before ? { seq: { lt: before } } : {}) },
    orderBy: { seq: 'desc' },
    take: AUDIT_PAGE_SIZE,
    select: { seq: true, at: true, actorId: true, action: true, subjectType: true, subjectId: true, data: true, hash: true },
  });
  const actorIds = [...new Set(events.map((e) => e.actorId).filter((id): id is string => id !== null))];
  const actors = await db().user.findMany({ where: { id: { in: actorIds }, orgId: user.orgId }, select: { id: true, email: true } });
  const emailOf = new Map(actors.map((a) => [a.id, a.email]));
  return events.map((e) => ({
    seq: e.seq,
    at: e.at,
    /** Null for the worker; the id when the user is no longer known. */
    actor: e.actorId === null ? null : (emailOf.get(e.actorId) ?? e.actorId),
    action: e.action,
    subjectType: e.subjectType,
    subjectId: e.subjectId,
    data: JSON.stringify(e.data, null, 2),
    hash: e.hash,
  }));
}

/** Re-derives the firm's whole chain now, for the page. */
export const verifyFirmChain = (user: SessionUser) => verifyAuditChain(db(), user.orgId);

export type NightlyCheck =
  | { state: 'NEVER_RUN' }
  | { state: 'STALE' | 'INTACT'; checkedAt: string; count: number; head: string }
  | { state: 'BROKEN'; checkedAt: string; seq: number; reason: string };

/** The firm's latest nightly check, and whether it has stopped running. A broken check outranks a stale one. */
export async function latestNightlyCheck(user: SessionUser, now = new Date()): Promise<NightlyCheck> {
  const check = await db().auditChainCheck.findFirst({ where: { orgId: user.orgId }, orderBy: { checkedAt: 'desc' } });
  if (!check) return { state: 'NEVER_RUN' };
  const checkedAt = check.checkedAt.toISOString();
  if (!check.ok) return { state: 'BROKEN', checkedAt, seq: check.brokenSeq!, reason: check.reason! };
  const stale = now.getTime() - check.checkedAt.getTime() > AUDIT_CHECK_STALE_MS;
  return { state: stale ? 'STALE' : 'INTACT', checkedAt, count: check.count, head: check.head! };
}
