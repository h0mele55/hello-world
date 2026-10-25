import 'server-only';
import type { SessionUser } from '@/auth';
import { AnchoringError } from '@/lib/anchoring/errors';
import { appendAuditEvent } from '@/lib/audit';
import { db } from '@/lib/db';
import { requireRole } from '@/lib/roles';
import { WATCH_STALE_MS } from '@/lib/staleness';

/**
 * The registry watch as the console shows it (#93): how far it has read the
 * chain, and the writes by the firm's issuer keys that the journal did not
 * make, until an admin has reviewed each. The watch itself runs outside the
 * app (scripts/watch-registry.ts).
 */

/** The watch runs every ten minutes; one older than this means it has stopped. */
export { WATCH_STALE_MS };
/** Open findings shown at once; more are counted, never hidden. */
export const OPEN_FINDINGS_SHOWN = 50;

export type WatchState = { state: 'NEVER_RUN' } | { state: 'CURRENT' | 'STALE'; checkedAt: string; lastBlock: string; chainId: number; registry: string };

export async function registryWatchState(user: SessionUser, now = new Date()): Promise<WatchState> {
  const watch = await db().registryWatch.findFirst({ where: { orgId: user.orgId }, orderBy: { checkedAt: 'desc' } });
  if (!watch) return { state: 'NEVER_RUN' };
  const stale = now.getTime() - watch.checkedAt.getTime() > WATCH_STALE_MS;
  return { state: stale ? 'STALE' : 'CURRENT', checkedAt: watch.checkedAt.toISOString(), lastBlock: watch.lastBlock.toString(), chainId: watch.chainId, registry: watch.registry };
}

/** How many findings wait for review: the console's banner. */
export const openUnjournaledCount = (user: SessionUser) => db().unjournaledWrite.count({ where: { orgId: user.orgId, reviewedAt: null } });

/** The open findings, a revocation's deadline first, then the newest. */
export async function openUnjournaledWrites(user: SessionUser) {
  const [rows, count] = await Promise.all([
    db().unjournaledWrite.findMany({
      where: { orgId: user.orgId, reviewedAt: null },
      orderBy: [{ effectiveAt: { sort: 'asc', nulls: 'last' } }, { blockNumber: 'desc' }],
      take: OPEN_FINDINGS_SHOWN,
    }),
    openUnjournaledCount(user),
  ]);
  return {
    count,
    rows: rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      chainId: r.chainId,
      recordId: r.recordId,
      txHash: r.txHash,
      blockNumber: Number(r.blockNumber),
      issuer: r.issuer,
      effectiveAt: r.effectiveAt?.toISOString() ?? null,
      foundAt: r.foundAt.toISOString(),
    })),
  };
}

/**
 * An admin marks a finding reviewed once someone has looked into it: the owner
 * cancelled the revocation, the key was retired, or the write turned out to be
 * the firm's own, lost from the journal. It is the firm's record of that, not
 * a fix; the runbook says what to do.
 */
export async function reviewUnjournaledWrite(user: SessionUser, id: string) {
  requireRole(user, 'reviewUnjournaledWrite');
  return db().$transaction(async (tx) => {
    const row = await tx.unjournaledWrite.findFirst({ where: { id, orgId: user.orgId }, select: { id: true, reviewedAt: true, kind: true, recordId: true, txHash: true } });
    if (!row) throw new AnchoringError('NOT_FOUND');
    if (row.reviewedAt) throw new AnchoringError('ALREADY_REVIEWED');
    const reviewedAt = new Date();
    const { count } = await tx.unjournaledWrite.updateMany({ where: { id, reviewedAt: null }, data: { reviewedById: user.id, reviewedAt } });
    if (count !== 1) throw new AnchoringError('ALREADY_REVIEWED');
    await appendAuditEvent(tx, {
      orgId: user.orgId,
      actorId: user.id,
      action: 'registry_watch.reviewed',
      subjectType: 'UnjournaledWrite',
      subjectId: id,
      data: { kind: row.kind, recordId: row.recordId, txHash: row.txHash },
    });
    return { reviewedAt: reviewedAt.toISOString() };
  });
}
