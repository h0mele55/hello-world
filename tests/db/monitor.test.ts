import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@/generated/prisma/client';
import type { ChainWriteStatus } from '@/generated/prisma/enums';
import { appendAuditEvent } from '@/lib/audit';
import { collectAlerts, MONITOR_THRESHOLDS } from '@/lib/monitor';

/**
 * The monitor (#68): one alert for each thing that needs a person, and none
 * for a firm whose jobs ran on time and whose writes are settled.
 */

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
const NOW = new Date('2026-10-25T12:00:00Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const ISSUER = `0x${'1'.repeat(40)}`;
let orgId: string;
let n = 0;

/** A firm whose nightly check and registry watch ran on time. */
async function healthyFirm() {
  await prisma.auditChainCheck.create({ data: { orgId, checkedAt: ago(2 * HOUR), ok: true, count: 0, head: `0x${'0'.repeat(64)}` } });
  await prisma.registryWatch.create({ data: { orgId, chainId: 31337, registry: `0x${'2'.repeat(40)}`, lastBlock: 10n, checkedAt: ago(5 * MINUTE) } });
}
/** A journal row in a given state: an audit-log head, which needs no report version, each on a registry of its own, as one head is in flight per registry. */
function write(status: ChainWriteStatus, data: { updatedAt?: Date; broadcastAt?: Date; error?: string } = {}) {
  n += 1;
  return prisma.chainWrite.create({
    data: { orgId, kind: 'AUDIT_HEAD', auditHead: `0x${n.toString(16).padStart(64, '0')}`, mode: 'LIVE', status, chainId: 31337, registry: `0x${n.toString(16).padStart(40, '0')}`, issuer: ISSUER, txHash: status === 'INTENT' ? null : `0x${n.toString(16).padStart(64, 'a')}`, ...data },
  });
}
const keyStatus = (data: { checkedAt: Date; low?: boolean; rpcDisagreedAt?: Date }) =>
  prisma.issuerKeyStatus.create({ data: { chainId: 31337, address: ISSUER, balanceWei: '1', low: false, ...data } });
const codes = async () => (await collectAlerts(prisma, NOW)).map((a) => a.code).sort();

beforeEach(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE "AuditChainCheck", "RegistryWatch", "UnjournaledWrite", "ChainWrite", "IssuerKeyStatus", "AuditEvent", "IssuerOrg" CASCADE');
  orgId = (await prisma.issuerOrg.create({ data: { name: 'Example Audit OOD' } })).id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('the monitor', () => {
  it('is quiet for a firm whose jobs ran on time and whose writes are settled', async () => {
    await healthyFirm();
    await write('FINAL');
    await write('FAILED', { updatedAt: ago(MONITOR_THRESHOLDS.recentMs + MINUTE) });
    expect(await collectAlerts(prisma, NOW)).toEqual([]);
  });

  it('reports a nightly check or a registry watch that never ran or stopped, and a broken check', async () => {
    expect(await codes()).toEqual(['AUDIT_CHECK_STALE', 'WATCH_STALE']);
    await prisma.auditChainCheck.create({ data: { orgId, checkedAt: ago(37 * HOUR), ok: true, count: 0, head: `0x${'0'.repeat(64)}` } });
    await prisma.registryWatch.create({ data: { orgId, chainId: 31337, registry: `0x${'2'.repeat(40)}`, lastBlock: 10n, checkedAt: ago(3 * HOUR) } });
    expect(await collectAlerts(prisma, NOW)).toEqual([
      { code: 'AUDIT_CHECK_STALE', orgId, detail: { lastRun: ago(37 * HOUR).toISOString() } },
      { code: 'WATCH_STALE', orgId, detail: { lastRun: ago(3 * HOUR).toISOString() } },
    ]);
    await prisma.auditChainCheck.create({ data: { orgId, checkedAt: ago(HOUR), ok: false, count: 0, reason: 'ANCHORED_HEAD_MISSING' } });
    expect(await collectAlerts(prisma, NOW)).toEqual(
      expect.arrayContaining([{ code: 'AUDIT_CHECK_BROKEN', orgId, detail: { seq: null, reason: 'ANCHORED_HEAD_MISSING', checkedAt: ago(HOUR).toISOString() } }]),
    );
  });

  it('reports failed writes for a day, unsettled ones, and sent ones that are not final after an hour', async () => {
    await healthyFirm();
    await keyStatus({ checkedAt: ago(MINUTE) });
    const failed = await write('FAILED', { updatedAt: ago(HOUR), error: 'TX_REVERTED' });
    const held = await write('INDETERMINATE', { error: 'SEND_OUTCOME_UNKNOWN' });
    const lagging = await write('BROADCAST', { broadcastAt: ago(2 * HOUR) });
    await write('BROADCAST', { broadcastAt: ago(10 * MINUTE) });
    const alerts = await collectAlerts(prisma, NOW);
    expect(alerts.map((a) => a.code).sort()).toEqual(['FINALITY_LAG', 'WRITE_FAILED', 'WRITE_INDETERMINATE']);
    expect(alerts).toEqual(
      expect.arrayContaining([
        { code: 'WRITE_FAILED', orgId, detail: { chainWriteId: failed.id, kind: 'AUDIT_HEAD', error: 'TX_REVERTED', at: ago(HOUR).toISOString() } },
        expect.objectContaining({ code: 'WRITE_INDETERMINATE', detail: expect.objectContaining({ chainWriteId: held.id, reason: 'SEND_OUTCOME_UNKNOWN', runbook: 'docs/runbooks/stuck-writes.md' }) }),
        { code: 'FINALITY_LAG', orgId, detail: { chainWriteId: lagging.id, kind: 'AUDIT_HEAD', txHash: lagging.txHash, broadcastAt: ago(2 * HOUR).toISOString() } },
      ]),
    );
  });

  it('reports a worker that has not passed while work waits for its key, and not one whose key has nothing to do', async () => {
    await healthyFirm();
    // A retired key's worker stopped long ago, and nothing waits for it.
    await keyStatus({ checkedAt: ago(30 * 24 * HOUR) });
    expect(await codes()).toEqual([]);
    await write('INTENT');
    expect(await collectAlerts(prisma, NOW)).toEqual([
      { code: 'WORKER_STOPPED', detail: { chainId: 31337, issuer: ISSUER, waiting: 1, lastPass: ago(30 * 24 * HOUR).toISOString() } },
    ]);
    await prisma.issuerKeyStatus.updateMany({ data: { checkedAt: ago(MINUTE) } });
    expect(await codes()).toEqual([]);
    // No pass at all for a key with work.
    await prisma.issuerKeyStatus.deleteMany();
    expect(await codes()).toEqual(['WORKER_STOPPED']);
  });

  it('reports a low balance and endpoints that disagree, for a key a worker passed for today', async () => {
    await healthyFirm();
    await keyStatus({ checkedAt: ago(MINUTE), low: true, rpcDisagreedAt: ago(20 * MINUTE) });
    expect(await collectAlerts(prisma, NOW)).toEqual([
      { code: 'LOW_BALANCE', detail: { chainId: 31337, issuer: ISSUER, balanceWei: '1', checkedAt: ago(MINUTE).toISOString(), runbook: 'docs/runbooks/stuck-writes.md' } },
      { code: 'RPC_DISAGREE', detail: { chainId: 31337, issuer: ISSUER, since: ago(20 * MINUTE).toISOString(), runbook: 'docs/runbooks/rpc-outage.md' } },
    ]);
    await prisma.issuerKeyStatus.updateMany({ data: { checkedAt: ago(2 * 24 * HOUR) } });
    expect(await codes()).toEqual([]);
  });

  it('reports writes the watch found until they are reviewed, and notices the mailer gave up on', async () => {
    await healthyFirm();
    const finding = await prisma.unjournaledWrite.create({
      data: { orgId, chainId: 31337, registry: `0x${'2'.repeat(40)}`, kind: 'REVOCATION', recordId: `0x${'3'.repeat(64)}`, txHash: `0x${'4'.repeat(64)}`, blockNumber: 5n, issuer: ISSUER, effectiveAt: new Date('2026-10-26T09:00:00Z'), foundAt: ago(HOUR) },
    });
    await prisma.$transaction((tx) =>
      appendAuditEvent(tx, { orgId, actorId: null, action: 'notification.failed', subjectType: 'Notification', subjectId: 'n1', data: { reason: 'SMTP_REFUSED', attempts: 5 } }, ago(3 * HOUR)),
    );
    expect(await collectAlerts(prisma, NOW)).toEqual([
      { code: 'UNJOURNALED_OPEN', orgId, detail: { count: 1, earliestDeadline: '2026-10-26T09:00:00.000Z', kinds: ['REVOCATION'], runbook: 'docs/runbooks/stolen-issuer-key.md' } },
      { code: 'NOTICE_FAILED', orgId, detail: { count: 1, runbook: 'docs/runbooks/mail.md' } },
    ]);
    await prisma.unjournaledWrite.update({ where: { id: finding.id }, data: { reviewedAt: NOW } });
    expect(await codes()).toEqual(['NOTICE_FAILED']);
    expect(await collectAlerts(prisma, new Date(NOW.getTime() + 24 * HOUR))).toEqual(expect.not.arrayContaining([expect.objectContaining({ code: 'NOTICE_FAILED' })]));
  });
});
