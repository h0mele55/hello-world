import fs from 'node:fs';
import path from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { SessionUser } from '@/auth';
import { PrismaClient } from '@/generated/prisma/client';
import type { ChainWriteKind } from '@/generated/prisma/enums';
import { approveVersion, setChainWriteMode } from '@/lib/anchoring/approve';
import type { AnchorTarget } from '@/lib/anchoring/target';
import { appendAuditEvent } from '@/lib/audit';
import { anchorsPerMonth, lookupsPerDay, writesByStatus } from '@/lib/console/dashboard';
import { CLIENT_LIST_CAP, getClient, getEngagementTimeline, listClients } from '@/lib/console/queries';
import { recordLookup } from '@/lib/lookups';
import { confirmOpinion, createEngagement, uploadVersion, type NewEngagement } from '@/lib/reports/intake';

/**
 * The console's reads: each is scoped to the caller's firm, and each figure on
 * the dashboard is a count of the firm's own rows.
 */

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
const fixture = (name: string) => fs.readFileSync(path.join(import.meta.dirname, '..', 'fixtures', 'pdf', name));

const TARGET: AnchorTarget = { network: 'local', chainId: 31337, registry: '0x5FbDB2315678afecb367f032d93F642f64180aa3', issuer: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' };
const ENGAGEMENT: NewEngagement = { clientName: 'Example Manufacturing AD', registrationNumber: '123456789', country: 'BG', engagementRef: 'ENG-2026-030', periodEnd: '2025-12-31', reportType: 'STANDALONE' };

let orgId: string;
let preparer: SessionUser;
let approver: SessionUser;
let outsider: SessionUser;

beforeEach(async () => {
  fs.rmSync(process.env.FILE_STORAGE_DIR!, { recursive: true, force: true });
  await prisma.$executeRawUnsafe('TRUNCATE "LookupCount", "ChainWrite", "AuditEvent", "ReportVersion", "StoredFile", "Engagement", "Client", "User", "IssuerOrg" CASCADE');
  const org = await prisma.issuerOrg.create({ data: { name: 'Example Audit OOD' } });
  const other = await prisma.issuerOrg.create({ data: { name: 'Another Firm' } });
  orgId = org.id;
  const make = async (org: string, email: string, role: 'PREPARER' | 'APPROVER'): Promise<SessionUser> => {
    const user = await prisma.user.create({ data: { orgId: org, email, name: email, role, passwordHash: 'x' } });
    return { id: user.id, email, name: email, role, orgId: org, mfa: role === 'APPROVER' ? 'VERIFIED' : 'NOT_REQUIRED' };
  };
  preparer = await make(org.id, 'preparer@example.test', 'PREPARER');
  approver = await make(org.id, 'approver@example.test', 'APPROVER');
  outsider = await make(other.id, 'outsider@example.test', 'PREPARER');
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function confirmed(engagementId: string, file: string, reasonCode: 'INITIAL' | 'CORRECTION' = 'INITIAL') {
  const uploaded = await uploadVersion(preparer, { engagementId, reasonCode, bytes: fixture(file) });
  await confirmOpinion(preparer, { versionId: uploaded.id, opinionType: 'UNMODIFIED', text: 'In our opinion, the financial statements present fairly.', reportDate: '2026-03-31' });
  return uploaded.id;
}

/** What the worker does when a write's block is final, at a chosen time: the journal row, the version, the audit event. */
async function finalise(versionId: string, kind: ChainWriteKind, at: Date, n: number) {
  const recordId = `0x${n.toString(16).padStart(64, '0')}`;
  const txHash = `0x${(n + 1000).toString(16).padStart(64, '0')}`;
  await prisma.$transaction(async (tx) => {
    const write =
      kind === 'ANCHOR'
        ? await tx.chainWrite.findFirstOrThrow({ where: { reportVersionId: versionId, kind } })
        : await tx.chainWrite.create({ data: { reportVersionId: versionId, kind, mode: 'LIVE', chainId: TARGET.chainId, registry: TARGET.registry, issuer: TARGET.issuer } });
    await tx.chainWrite.update({ where: { id: write.id }, data: { status: 'FINAL', txHash, blockNumber: BigInt(100 + n), recordId } });
    if (kind === 'ANCHOR') await tx.reportVersion.update({ where: { id: versionId }, data: { status: 'ANCHORED', recordId, anchorTxHash: txHash, anchorBlock: BigInt(100 + n) } });
    await appendAuditEvent(tx, { orgId, actorId: null, action: 'anchor.final', subjectType: 'ChainWrite', subjectId: write.id, data: { recordId } }, at);
  });
}

async function goLive() {
  await setChainWriteMode(approver, 'DRY_RUN');
  await setChainWriteMode(approver, 'LIVE');
}

describe('the client list', () => {
  it('lists the firm’s clients only, with their engagements and the versions still in progress', async () => {
    const first = await createEngagement(preparer, ENGAGEMENT);
    await createEngagement(preparer, { ...ENGAGEMENT, engagementRef: 'ENG-2026-031' });
    await createEngagement(preparer, { ...ENGAGEMENT, clientName: 'Another Client EOOD', registrationNumber: '987654321' });
    await createEngagement(outsider, { ...ENGAGEMENT, clientName: 'Not Ours AD', registrationNumber: '111111111' });
    const versionId = await confirmed(first.id, 'en-unmodified.pdf');

    const { clients, truncated } = await listClients(preparer);
    expect(truncated).toBe(false);
    expect(clients.map((c) => c.name)).toEqual(['Another Client EOOD', 'Example Manufacturing AD']);
    const example = clients[1];
    expect(example).toMatchObject({ registrationNumber: '123456789', country: 'BG', engagements: 2, inProgress: 1 });
    const version = await prisma.reportVersion.findUniqueOrThrow({ where: { id: versionId } });
    expect(example.lastActivity).toBe(version.createdAt.toISOString());
  });

  it('says when the list is cut at its cap rather than looking complete', async () => {
    await prisma.client.createMany({
      data: Array.from({ length: CLIENT_LIST_CAP + 1 }, (_, i) => ({ orgId, name: `Client ${String(i).padStart(4, '0')}`, registrationNumber: `R${i}`, country: 'BG' })),
    });
    const { clients, truncated } = await listClients(preparer);
    expect(truncated).toBe(true);
    expect(clients).toHaveLength(CLIENT_LIST_CAP);
    expect(clients.at(-1)!.name).toBe(`Client ${String(CLIENT_LIST_CAP - 1).padStart(4, '0')}`);
  });

  it('reads another firm’s client as absent, and lists a client’s engagements with their latest version', async () => {
    const engagement = await createEngagement(preparer, ENGAGEMENT);
    const empty = await createEngagement(preparer, { ...ENGAGEMENT, engagementRef: 'ENG-2026-031', periodEnd: '2024-12-31' });
    await confirmed(engagement.id, 'en-unmodified.pdf');
    const clientId = (await prisma.engagement.findUniqueOrThrow({ where: { id: engagement.id } })).clientId;

    expect(await getClient(outsider, clientId)).toBeNull();
    const client = await getClient(preparer, clientId);
    expect(client?.engagements).toEqual([
      { id: engagement.id, engagementRef: 'ENG-2026-030', periodEnd: '2025-12-31', reportType: 'STANDALONE', versions: 1, latestStatus: 'CONFIRMED', latestVersion: 1 },
      { id: empty.id, engagementRef: 'ENG-2026-031', periodEnd: '2024-12-31', reportType: 'STANDALONE', versions: 0, latestStatus: null, latestVersion: null },
    ]);
  });
});

describe('the version timeline', () => {
  it('shows versions newest first, with who prepared and approved each and where its anchor landed', async () => {
    const engagement = await createEngagement(preparer, ENGAGEMENT);
    const v1 = await confirmed(engagement.id, 'en-unmodified.pdf');
    await goLive();
    await approveVersion(approver, v1, TARGET);
    await finalise(v1, 'ANCHOR', new Date(), 1);
    await confirmed(engagement.id, 'en-qualified.pdf', 'CORRECTION');

    expect(await getEngagementTimeline(outsider, engagement.id)).toBeNull();
    const timeline = await getEngagementTimeline(preparer, engagement.id);
    expect(timeline!.versions.map((v) => [v.version, v.status, v.reasonCode])).toEqual([
      [2, 'CONFIRMED', 'CORRECTION'],
      [1, 'ANCHORED', 'INITIAL'],
    ]);
    const [second, first] = timeline!.versions;
    expect(second).toMatchObject({ preparedBy: 'preparer@example.test', approvedBy: null, recordId: null, anchorBlock: null, chainId: null });
    expect(first).toMatchObject({ preparedBy: 'preparer@example.test', approvedBy: 'approver@example.test', anchorBlock: '101', chainId: 31337 });
    expect(first.recordId).toMatch(/^0x0{63}1$/);
  });
});

describe('the dashboard', () => {
  it('counts writes that reached a final block per UTC month and kind, from the audit log', async () => {
    const now = new Date('2026-10-25T12:00:00Z');
    const a = await createEngagement(preparer, ENGAGEMENT);
    const b = await createEngagement(preparer, { ...ENGAGEMENT, engagementRef: 'ENG-2026-031' });
    const v1 = await confirmed(a.id, 'en-unmodified.pdf');
    const v2 = await confirmed(b.id, 'en-qualified.pdf');
    await goLive();
    await approveVersion(approver, v1, TARGET);
    await approveVersion(approver, v2, TARGET);
    await finalise(v1, 'ANCHOR', new Date('2026-08-31T23:59:59Z'), 1);
    await finalise(v1, 'ANCHOR_COPY', new Date('2026-09-01T00:00:00Z'), 2);
    await finalise(v2, 'ANCHOR', new Date('2026-10-02T08:00:00Z'), 3);
    // Before the window: twelve months back from October 2026 starts in November 2025.
    await finalise(v2, 'ANCHOR_COPY', new Date('2025-10-31T23:00:00Z'), 4);

    const months = await anchorsPerMonth(approver, now);
    expect(months).toHaveLength(12);
    expect(months[0].month).toBe('2025-11');
    const nonZero = months.filter((m) => m.ANCHOR + m.ANCHOR_COPY + m.REVOKE > 0);
    expect(nonZero).toEqual([
      { month: '2026-08', ANCHOR: 1, ANCHOR_COPY: 0, REVOKE: 0 },
      { month: '2026-09', ANCHOR: 0, ANCHOR_COPY: 1, REVOKE: 0 },
      { month: '2026-10', ANCHOR: 1, ANCHOR_COPY: 0, REVOKE: 0 },
    ]);
    expect((await anchorsPerMonth(outsider, now)).every((m) => m.ANCHOR + m.ANCHOR_COPY + m.REVOKE === 0)).toBe(true);

    const writes = await writesByStatus(approver);
    expect(writes.LIVE).toMatchObject({ FINAL: 4, INTENT: 0 });
    expect((await writesByStatus(outsider)).LIVE.FINAL).toBe(0);
  });

  it('counts lookups of the firm’s own families per UTC day, and nothing else', async () => {
    const engagement = await createEngagement(preparer, ENGAGEMENT);
    const familyId = (await prisma.engagement.findUniqueOrThrow({ where: { id: engagement.id } })).familyId;
    await Promise.all([recordLookup(familyId), recordLookup(familyId.toUpperCase().replace('0X', '0x')), recordLookup(familyId)]);
    // Unknown and malformed ids change nothing.
    await recordLookup(`0x${'ab'.repeat(32)}`);
    await recordLookup('not-a-family');

    const days = await lookupsPerDay(preparer);
    expect(days).toHaveLength(30);
    expect(days.at(-1)).toEqual({ day: new Date().toISOString().slice(0, 10), count: 3 });
    expect(days.slice(0, -1).every((d) => d.count === 0)).toBe(true);
    expect((await lookupsPerDay(outsider)).every((d) => d.count === 0)).toBe(true);
    expect(await prisma.lookupCount.count()).toBe(1);
  });
});
