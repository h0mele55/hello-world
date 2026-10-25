import type { PrismaClient } from '@/generated/prisma/client';
import { AUDIT_CHECK_STALE_MS, WATCH_STALE_MS, WORKER_STALE_MS } from '@/lib/staleness';

/**
 * What needs a person, across everything that runs besides the app (#68):
 * writes that failed or wait too long for finality, an issuer key held by an
 * unsettled write, a worker that stopped, a low balance, endpoints that
 * disagree, a broken or stopped audit check, a stopped registry watch or a
 * write it found, and notices that could not be sent. `npm run monitor`
 * (scripts/monitor.ts) prints each and exits 1, for the scheduler to alert.
 *
 * Alerts carry ids, codes, counts and times only: never a client's name, a
 * file, an opinion or an address someone was mailed at.
 */

export type AlertCode =
  | 'WRITE_FAILED'
  | 'WRITE_INDETERMINATE'
  | 'FINALITY_LAG'
  | 'WORKER_STOPPED'
  | 'LOW_BALANCE'
  | 'RPC_DISAGREE'
  | 'AUDIT_CHECK_BROKEN'
  | 'AUDIT_CHECK_STALE'
  | 'WATCH_STALE'
  | 'UNJOURNALED_OPEN'
  | 'NOTICE_FAILED';

export interface Alert {
  code: AlertCode;
  /** The firm, when the alert is about one. */
  orgId?: string;
  /** Ids, codes, counts and ISO times; enough to start from, never confidential. */
  detail: Record<string, unknown>;
}

export const MONITOR_THRESHOLDS = {
  /** A failure is reported for a day: long enough for a scheduler that runs the monitor hourly to see it. */
  recentMs: 24 * 60 * 60 * 1000,
  /** A sent write that is not final after this has met a stuck fee or a stalled chain (Sepolia finalizes in about 13 minutes, the rollups in 15 to 20). */
  finalityLagMs: 60 * 60 * 1000,
  workerStaleMs: WORKER_STALE_MS,
  auditCheckStaleMs: AUDIT_CHECK_STALE_MS,
  watchStaleMs: WATCH_STALE_MS,
};

const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;

export async function collectAlerts(prisma: PrismaClient, now = new Date(), t = MONITOR_THRESHOLDS): Promise<Alert[]> {
  const alerts: Alert[] = [];
  const since = (ms: number) => new Date(now.getTime() - ms);

  // ── The journal and the worker ──
  const failed = await prisma.chainWrite.findMany({
    where: { status: 'FAILED', updatedAt: { gte: since(t.recentMs) } },
    select: { id: true, orgId: true, kind: true, error: true, updatedAt: true },
    orderBy: { updatedAt: 'desc' },
    take: 50,
  });
  for (const w of failed) alerts.push({ code: 'WRITE_FAILED', orgId: w.orgId, detail: { chainWriteId: w.id, kind: w.kind, error: w.error, at: iso(w.updatedAt) } });

  const indeterminate = await prisma.chainWrite.findMany({ where: { status: 'INDETERMINATE' }, select: { id: true, orgId: true, kind: true, error: true, chainId: true, issuer: true }, take: 50 });
  for (const w of indeterminate) {
    alerts.push({ code: 'WRITE_INDETERMINATE', orgId: w.orgId, detail: { chainWriteId: w.id, kind: w.kind, reason: w.error, chainId: w.chainId, issuer: w.issuer, runbook: 'docs/runbooks/stuck-writes.md' } });
  }

  const lagging = await prisma.chainWrite.findMany({
    where: { status: 'BROADCAST', broadcastAt: { lt: since(t.finalityLagMs) } },
    select: { id: true, orgId: true, kind: true, txHash: true, broadcastAt: true },
    take: 50,
  });
  for (const w of lagging) alerts.push({ code: 'FINALITY_LAG', orgId: w.orgId, detail: { chainWriteId: w.id, kind: w.kind, txHash: w.txHash, broadcastAt: iso(w.broadcastAt) } });

  // A key with work waiting whose worker has not passed lately. A key with no
  // work (a retired one) is not watched: its worker is meant to have stopped.
  const waiting = await prisma.chainWrite.groupBy({ by: ['chainId', 'issuer'], where: { status: { in: ['INTENT', 'BROADCAST', 'INDETERMINATE'] } }, _count: true });
  const statuses = await prisma.issuerKeyStatus.findMany();
  const statusOf = new Map(statuses.map((s) => [`${s.chainId}:${s.address.toLowerCase()}`, s]));
  for (const key of waiting) {
    const status = statusOf.get(`${key.chainId}:${key.issuer.toLowerCase()}`);
    if (!status || status.checkedAt < since(t.workerStaleMs)) {
      alerts.push({ code: 'WORKER_STOPPED', detail: { chainId: key.chainId, issuer: key.issuer, waiting: key._count, lastPass: iso(status?.checkedAt) } });
    }
  }
  // The balance and the endpoints, for keys a worker has passed for within the day.
  for (const s of statuses) {
    if (s.checkedAt < since(t.recentMs)) continue;
    if (s.low) alerts.push({ code: 'LOW_BALANCE', detail: { chainId: s.chainId, issuer: s.address, balanceWei: s.balanceWei, checkedAt: iso(s.checkedAt), runbook: 'docs/runbooks/stuck-writes.md' } });
    if (s.rpcDisagreedAt) alerts.push({ code: 'RPC_DISAGREE', detail: { chainId: s.chainId, issuer: s.address, since: iso(s.rpcDisagreedAt), runbook: 'docs/runbooks/rpc-outage.md' } });
  }

  // ── Per firm: the audit check, the registry watch, the mailer ──
  const orgs = await prisma.issuerOrg.findMany({ select: { id: true } });
  for (const { id: orgId } of orgs) {
    const check = await prisma.auditChainCheck.findFirst({ where: { orgId }, orderBy: { checkedAt: 'desc' } });
    if (check && !check.ok) {
      alerts.push({ code: 'AUDIT_CHECK_BROKEN', orgId, detail: { seq: check.brokenSeq, reason: check.reason, checkedAt: iso(check.checkedAt) } });
    } else if (!check || check.checkedAt < since(t.auditCheckStaleMs)) {
      alerts.push({ code: 'AUDIT_CHECK_STALE', orgId, detail: { lastRun: iso(check?.checkedAt) } });
    }

    const watch = await prisma.registryWatch.findFirst({ where: { orgId }, orderBy: { checkedAt: 'desc' } });
    if (!watch || watch.checkedAt < since(t.watchStaleMs)) alerts.push({ code: 'WATCH_STALE', orgId, detail: { lastRun: iso(watch?.checkedAt) } });
    const open = await prisma.unjournaledWrite.findMany({ where: { orgId, reviewedAt: null }, select: { kind: true, effectiveAt: true }, orderBy: { effectiveAt: { sort: 'asc', nulls: 'last' } } });
    if (open.length) {
      alerts.push({ code: 'UNJOURNALED_OPEN', orgId, detail: { count: open.length, earliestDeadline: iso(open[0].effectiveAt), kinds: [...new Set(open.map((w) => w.kind))], runbook: 'docs/runbooks/stolen-issuer-key.md' } });
    }

    // The mailer records each notice it gave up on in the audit log, with its time.
    const notices = await prisma.auditEvent.count({ where: { orgId, action: 'notification.failed', at: { gte: since(t.recentMs).toISOString() } } });
    if (notices) alerts.push({ code: 'NOTICE_FAILED', orgId, detail: { count: notices, runbook: 'docs/runbooks/mail.md' } });
  }
  return alerts;
}
