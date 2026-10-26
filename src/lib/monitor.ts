import type { PrismaClient } from '@/generated/prisma/client';
import { monthStart, previousMonth } from '@/lib/console/periods';
import { AUDIT_CHECK_STALE_MS, WATCH_STALE_MS, WORKER_STALE_MS } from '@/lib/staleness';

/**
 * What needs a person, across everything that runs besides the app (#68):
 * writes that failed or wait too long for finality, an issuer key held by an
 * unsettled write, a worker that stopped, a low balance, endpoints that
 * disagree, a broken or stopped audit check, a stopped registry watch or a
 * write it found, notices that could not be sent, OpenTimestamps proofs
 * that were not made, wait too long for Bitcoin or turned out wrong (#66), a
 * month without its checkpoint (#122), and distribution copies held up by a
 * seal provider that does not answer (#70). `npm run monitor`
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
  | 'NOTICE_FAILED'
  | 'OTS_NOT_SUBMITTED'
  | 'OTS_PENDING_LONG'
  | 'OTS_BROKEN'
  | 'CHECKPOINT_MISSING'
  | 'SEAL_WAITING';

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
  /** A version final this long ago (counted from its approval) should have its OpenTimestamps proof: the job submits every pass. */
  otsSubmitMs: 24 * 60 * 60 * 1000,
  /** Calendars put their batches on Bitcoin within hours; two days is a calendar or an explorer that stopped. */
  otsPendingMs: 48 * 60 * 60 * 1000,
  /** A copy the worker has tried to seal for this long has a provider that is down, not busy. */
  sealWaitMs: 60 * 60 * 1000,
  /** The checkpoint runs on the 1st; by the 3rd, a month without one has a job that did not run. */
  checkpointGraceMs: 2 * 24 * 60 * 60 * 1000,
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

  // A copy waiting on its seal (#70): the worker tries again every pass, so an hour is a provider that is down.
  const unsealed = await prisma.chainWrite.findMany({
    where: { kind: 'ANCHOR_COPY', status: 'INTENT', error: { startsWith: 'SEAL_' }, createdAt: { lt: since(t.sealWaitMs) } },
    select: { id: true, orgId: true, error: true, createdAt: true },
    take: 50,
  });
  for (const w of unsealed) {
    alerts.push({ code: 'SEAL_WAITING', orgId: w.orgId, detail: { chainWriteId: w.id, reason: w.error, since: iso(w.createdAt), runbook: 'docs/runbooks/seal-provider.md' } });
  }

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

    // The OpenTimestamps job (#66), for versions and checkpoints (#122).
    const ofFirm = { OR: [{ reportVersion: { engagement: { client: { orgId } } } }, { checkpoint: { orgId } }] };
    const unsubmitted = await prisma.reportVersion.findMany({
      where: { engagement: { client: { orgId } }, status: { in: ['ANCHORED', 'COMPLETE', 'REVOKED'] }, manifestHash: { not: null }, otsProof: null, approvedAt: { lt: since(t.otsSubmitMs) } },
      select: { approvedAt: true },
      orderBy: { approvedAt: 'asc' },
    });
    if (unsubmitted.length) alerts.push({ code: 'OTS_NOT_SUBMITTED', orgId, detail: { count: unsubmitted.length, oldestApprovedAt: iso(unsubmitted[0].approvedAt), runbook: 'docs/runbooks/opentimestamps.md' } });
    const unsubmittedCheckpoints = await prisma.registryCheckpoint.findMany({ where: { orgId, otsProof: null, createdAt: { lt: since(t.otsSubmitMs) } }, select: { period: true }, orderBy: { createdAt: 'asc' } });
    if (unsubmittedCheckpoints.length) alerts.push({ code: 'OTS_NOT_SUBMITTED', orgId, detail: { checkpoints: unsubmittedCheckpoints.map((c) => c.period), runbook: 'docs/runbooks/opentimestamps.md' } });
    const waitingOts = await prisma.otsProof.findMany({ where: { ...ofFirm, status: 'PENDING', submittedAt: { lt: since(t.otsPendingMs) } }, select: { submittedAt: true, lastError: true }, orderBy: { submittedAt: 'asc' } });
    if (waitingOts.length) {
      alerts.push({
        code: 'OTS_PENDING_LONG',
        orgId,
        detail: { count: waitingOts.length, oldestSubmittedAt: iso(waitingOts[0].submittedAt), reasons: [...new Set(waitingOts.map((p) => p.lastError).filter(Boolean))], runbook: 'docs/runbooks/opentimestamps.md' },
      });
    }
    const brokenOts = await prisma.otsProof.findMany({ where: { ...ofFirm, status: 'BROKEN', checkedAt: { gte: since(t.recentMs) } }, select: { id: true, reportVersionId: true, checkpointId: true, lastError: true, checkedAt: true }, take: 50 });
    for (const p of brokenOts) {
      alerts.push({ code: 'OTS_BROKEN', orgId, detail: { otsProofId: p.id, reportVersionId: p.reportVersionId, checkpointId: p.checkpointId, reason: p.lastError, at: iso(p.checkedAt), runbook: 'docs/runbooks/opentimestamps.md' } });
    }

    // The monthly checkpoint (#122): due for every month that ended with a version anchored.
    const started = monthStart(now);
    if (now.getTime() - started.getTime() > t.checkpointGraceMs) {
      const period = previousMonth(now);
      const due = await prisma.reportVersion.count({ where: { engagement: { client: { orgId } }, status: { in: ['ANCHORED', 'COMPLETE', 'REVOKED'] }, approvedAt: { lt: started } } });
      if (due && !(await prisma.registryCheckpoint.findFirst({ where: { orgId, period }, select: { id: true } }))) {
        alerts.push({ code: 'CHECKPOINT_MISSING', orgId, detail: { period, runbook: 'docs/runbooks/checkpoints.md' } });
      }
    }
  }
  return alerts;
}
