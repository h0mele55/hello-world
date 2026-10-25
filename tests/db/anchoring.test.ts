import fs from 'node:fs';
import path from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { SessionUser } from '@/auth';
import { PrismaClient } from '@/generated/prisma/client';
import { approveVersion, getChainWriteMode, setChainWriteMode } from '@/lib/anchoring/approve';
import { AnchoringError } from '@/lib/anchoring/errors';
import type { AnchorTarget } from '@/lib/anchoring/target';
import { ADVISORY_LOCK_CLASS, appendAuditEvent, auditHashOf, GENESIS_HASH, verifyAuditChain } from '@/lib/audit';
import { confirmOpinion, createEngagement, discardDraft, uploadVersion, type NewEngagement } from '@/lib/reports/intake';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
const fixture = (name: string) => fs.readFileSync(path.join(import.meta.dirname, '..', 'fixtures', 'pdf', name));

const TARGET: AnchorTarget = {
  network: 'local',
  chainId: 31337,
  registry: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
  issuer: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
};

const ENGAGEMENT: NewEngagement = {
  clientName: 'Example Manufacturing AD',
  registrationNumber: '123456789',
  country: 'BG',
  engagementRef: 'ENG-2026-020',
  periodEnd: '2025-12-31',
  reportType: 'STANDALONE',
};

let orgId: string;
let preparer: SessionUser;
let approver: SessionUser;
let secondApprover: SessionUser;
let outsider: SessionUser;

async function expectCode(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AnchoringError);
  expect((error as AnchoringError).code).toBe(code);
}

async function confirmedVersion(engagementId: string, file: string, reasonCode: 'INITIAL' | 'CORRECTION' = 'INITIAL') {
  const uploaded = await uploadVersion(preparer, { engagementId, reasonCode, bytes: fixture(file) });
  await confirmOpinion(preparer, { versionId: uploaded.id, opinionType: 'UNMODIFIED', text: 'In our opinion, the financial statements present fairly.', reportDate: '2026-03-31' });
  return uploaded.id;
}

beforeEach(async () => {
  fs.rmSync(process.env.FILE_STORAGE_DIR!, { recursive: true, force: true });
  await prisma.$executeRawUnsafe('TRUNCATE "ChainWrite", "AuditEvent", "ReportVersion", "StoredFile", "Engagement", "Client", "User", "IssuerOrg" CASCADE');
  const org = await prisma.issuerOrg.create({ data: { name: 'Example Audit OOD' } });
  const other = await prisma.issuerOrg.create({ data: { name: 'Another Firm' } });
  orgId = org.id;
  const make = async (org: string, email: string, role: 'PREPARER' | 'APPROVER'): Promise<SessionUser> => {
    const user = await prisma.user.create({ data: { orgId: org, email, name: email, role, passwordHash: 'x' } });
    return { id: user.id, email, name: email, role, orgId: org, mfa: role === 'APPROVER' ? 'VERIFIED' : 'NOT_REQUIRED' };
  };
  preparer = await make(org.id, 'preparer@example.test', 'PREPARER');
  approver = await make(org.id, 'approver@example.test', 'APPROVER');
  secondApprover = await make(org.id, 'approver2@example.test', 'APPROVER');
  outsider = await make(other.id, 'outsider@example.test', 'APPROVER');
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('the audit log', () => {
  it('records every intake step, hash-chained, and verifies', async () => {
    const engagement = await createEngagement(preparer, ENGAGEMENT);
    const versionId = await confirmedVersion(engagement.id, 'en-unmodified.pdf');
    const draft = await createEngagement(preparer, { ...ENGAGEMENT, engagementRef: 'ENG-2026-021' });
    const uploaded = await uploadVersion(preparer, { engagementId: draft.id, reasonCode: 'INITIAL', bytes: fixture('en-adverse.pdf') });
    await discardDraft(preparer, uploaded.id);

    const events = await prisma.auditEvent.findMany({ where: { orgId }, orderBy: { seq: 'asc' } });
    expect(events.map((e) => e.action)).toEqual([
      'engagement.created',
      'version.uploaded',
      'version.confirmed',
      'engagement.created',
      'version.uploaded',
      'version.discarded',
    ]);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(events[0].prevHash).toBe(GENESIS_HASH);
    expect(events[2]).toMatchObject({ subjectId: versionId, actorId: preparer.id });
    for (let i = 1; i < events.length; i++) expect(events[i].prevHash).toBe(events[i - 1].hash);
    expect(await verifyAuditChain(prisma, orgId)).toEqual({ ok: true, count: 6, head: events[5].hash });
  });

  it('never holds an opinion, a client name or a manifest', async () => {
    const engagement = await createEngagement(preparer, ENGAGEMENT);
    await confirmedVersion(engagement.id, 'en-unmodified.pdf');
    const all = JSON.stringify(await prisma.auditEvent.findMany({ select: { data: true } }));
    expect(all).not.toContain('Example Manufacturing');
    expect(all).not.toContain('In our opinion');
    expect(all).not.toContain('manifestSalt');
  });

  it('refuses UPDATE and DELETE', async () => {
    await createEngagement(preparer, ENGAGEMENT);
    await expect(prisma.$executeRawUnsafe(`UPDATE "AuditEvent" SET "action" = 'x'`)).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRawUnsafe('DELETE FROM "AuditEvent"')).rejects.toThrow(/append-only/);
  });

  it('finds a forged, an edited and a missing event', async () => {
    await createEngagement(preparer, ENGAGEMENT);
    await createEngagement(preparer, { ...ENGAGEMENT, engagementRef: 'ENG-2026-022' });
    const [, second] = await prisma.auditEvent.findMany({ where: { orgId }, orderBy: { seq: 'asc' } });

    // A row appended with a made-up hash.
    const forged = { orgId, seq: 3, at: new Date().toISOString(), actorId: null, action: 'version.approved', subjectType: 'ReportVersion', subjectId: 'x', data: {} };
    await prisma.auditEvent.create({ data: { ...forged, prevHash: second.hash, hash: `0x${'ab'.repeat(32)}` } });
    expect(await verifyAuditChain(prisma, orgId)).toEqual({ ok: false, seq: 3, reason: 'HASH_MISMATCH' });

    // An owner who bypasses the trigger to edit an event.
    await prisma.$executeRawUnsafe('ALTER TABLE "AuditEvent" DISABLE TRIGGER "AuditEvent_append_only"');
    try {
      await prisma.$executeRawUnsafe(`DELETE FROM "AuditEvent" WHERE seq = 3`);
      await prisma.$executeRawUnsafe(`UPDATE "AuditEvent" SET "data" = '{"familyId":"0x00"}' WHERE seq = 1 AND "orgId" = '${orgId}'`);
      expect(await verifyAuditChain(prisma, orgId)).toEqual({ ok: false, seq: 1, reason: 'HASH_MISMATCH' });
      await prisma.$executeRawUnsafe(`DELETE FROM "AuditEvent" WHERE seq = 1 AND "orgId" = '${orgId}'`);
      expect(await verifyAuditChain(prisma, orgId)).toEqual({ ok: false, seq: 2, reason: 'SEQ_GAP' });
    } finally {
      await prisma.$executeRawUnsafe('ALTER TABLE "AuditEvent" ENABLE TRIGGER "AuditEvent_append_only"');
    }
  });

  it('serialises concurrent appends into one chain', async () => {
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        prisma.$transaction((tx) =>
          appendAuditEvent(tx, { orgId, actorId: null, action: 'anchor.final', subjectType: 'ChainWrite', subjectId: `w${i}`, data: { i } }),
        ),
      ),
    );
    expect(await verifyAuditChain(prisma, orgId)).toMatchObject({ ok: true, count: 12 });
  });

  it('hashes the canonical event, whatever order its keys are stored in', () => {
    const event = { orgId: 'o', seq: 1, at: '2026-10-25T00:00:00.000Z', actorId: null, action: 'a', subjectType: 's', subjectId: 'i' };
    expect(auditHashOf(GENESIS_HASH, { ...event, data: { b: 1, a: [2, 'x'] } })).toBe(auditHashOf(GENESIS_HASH, { ...event, data: { a: [2, 'x'], b: 1 } }));
    expect(auditHashOf(GENESIS_HASH, { ...event, data: { a: 1 } })).not.toBe(auditHashOf(GENESIS_HASH, { ...event, data: { a: 2 } }));
  });
});

describe('the write mode', () => {
  it('starts DISABLED, widens one rung at a time, narrows at once, and is audited', async () => {
    expect(await getChainWriteMode(approver)).toBe('DISABLED');
    await expectCode(setChainWriteMode(approver, 'LIVE'), 'MODE_SKIPS_RUNG');
    await expectCode(setChainWriteMode(approver, 'DISABLED'), 'MODE_UNCHANGED');
    await expect(setChainWriteMode(preparer, 'DRY_RUN')).rejects.toMatchObject({ name: 'AccessError', code: 'FORBIDDEN' });
    await setChainWriteMode(approver, 'DRY_RUN');
    await setChainWriteMode(approver, 'LIVE');
    await setChainWriteMode(approver, 'DISABLED');
    expect(await getChainWriteMode(approver)).toBe('DISABLED');
    const changes = await prisma.auditEvent.findMany({ where: { orgId, action: 'chain_mode.changed' }, orderBy: { seq: 'asc' } });
    expect(changes.map((e) => e.data)).toEqual([
      { from: 'DISABLED', to: 'DRY_RUN' },
      { from: 'DRY_RUN', to: 'LIVE' },
      { from: 'LIVE', to: 'DISABLED' },
    ]);
    // Another firm's mode is its own.
    expect(await getChainWriteMode(outsider)).toBe('DISABLED');
  });
});

describe('approval (rule 6)', () => {
  it('queues the anchor: APPROVED plus an INTENT row, in one audited step', async () => {
    await setChainWriteMode(approver, 'DRY_RUN');
    await setChainWriteMode(approver, 'LIVE');
    const engagement = await createEngagement(preparer, ENGAGEMENT);
    const versionId = await confirmedVersion(engagement.id, 'en-unmodified.pdf');
    const { chainWriteId, mode } = await approveVersion(approver, versionId, TARGET);
    expect(mode).toBe('LIVE');

    const version = await prisma.reportVersion.findUniqueOrThrow({ where: { id: versionId } });
    expect(version).toMatchObject({ status: 'APPROVED', approvedById: approver.id });
    const write = await prisma.chainWrite.findUniqueOrThrow({ where: { id: chainWriteId } });
    expect(write).toMatchObject({ status: 'INTENT', kind: 'ANCHOR', mode: 'LIVE', chainId: 31337, registry: TARGET.registry, issuer: TARGET.issuer, txHash: null, nonce: null });
    const approved = await prisma.auditEvent.findFirstOrThrow({ where: { action: 'version.approved' } });
    expect(approved).toMatchObject({ actorId: approver.id, subjectId: versionId });
    expect(approved.data).toMatchObject({ chainWriteId, mode: 'LIVE', docHash: version.docHash });
    await expectCode(approveVersion(secondApprover, versionId, TARGET), 'NOT_CONFIRMED');
  });

  it('does not deadlock with another audited write in the same firm', async () => {
    await setChainWriteMode(approver, 'DRY_RUN');
    const engagement = await createEngagement(preparer, ENGAGEMENT);
    const versionId = await confirmedVersion(engagement.id, 'en-unmodified.pdf');

    // Another audited write is mid-transaction: it holds the firm's audit lock
    // and has yet to insert its event, whose foreign key reaches the firm's row.
    let letItFinish!: () => void;
    const finish = new Promise<void>((resolve) => (letItFinish = resolve));
    const other = prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ADVISORY_LOCK_CLASS.AUDIT}::int, hashtext(${orgId}))`;
        await finish;
        await appendAuditEvent(tx, { orgId, actorId: preparer.id, action: 'engagement.created', subjectType: 'Engagement', subjectId: 'concurrent', data: {} });
      },
      { timeout: 20_000 },
    );
    // The approval locks the firm's row, then waits for the audit lock.
    const approval = approveVersion(approver, versionId, TARGET);
    const waitingForAuditLock = async () =>
      (await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`)[0].n > 0n;
    for (let i = 0; i < 100 && !(await waitingForAuditLock()); i++) await new Promise((r) => setTimeout(r, 20));
    expect(await waitingForAuditLock()).toBe(true);

    // The other write now inserts its event. Under FOR UPDATE on the firm's
    // row, that insert's key-share lock waits on the approval, and the
    // approval on the audit lock: Postgres aborts one of them as a deadlock.
    letItFinish();
    await expect(Promise.all([other, approval])).resolves.toEqual([undefined, expect.objectContaining({ mode: 'DRY_RUN' })]);
    expect(await verifyAuditChain(prisma, orgId)).toMatchObject({ ok: true });
  });

  it('refuses a preparer, another firm, a draft, a disabled firm and a missing chain', async () => {
    const engagement = await createEngagement(preparer, ENGAGEMENT);
    const versionId = await confirmedVersion(engagement.id, 'en-unmodified.pdf');
    await expectCode(approveVersion(approver, versionId, TARGET), 'CHAIN_WRITES_DISABLED');
    await setChainWriteMode(approver, 'DRY_RUN');
    await expect(approveVersion(preparer, versionId, TARGET)).rejects.toMatchObject({ name: 'AccessError', code: 'FORBIDDEN' });
    await expectCode(approveVersion(approver, versionId, null), 'CHAIN_NOT_CONFIGURED');
    await expectCode(approveVersion(outsider, versionId, TARGET), 'CHAIN_WRITES_DISABLED');
    await prisma.issuerOrg.update({ where: { id: outsider.orgId }, data: { chainWriteMode: 'LIVE' } });
    await expectCode(approveVersion(outsider, versionId, TARGET), 'NOT_FOUND');

    const second = await createEngagement(preparer, { ...ENGAGEMENT, engagementRef: 'ENG-2026-023' });
    const draft = await uploadVersion(preparer, { engagementId: second.id, reasonCode: 'INITIAL', bytes: fixture('en-adverse.pdf') });
    await expectCode(approveVersion(approver, draft.id, TARGET), 'NOT_CONFIRMED');
    expect(await prisma.chainWrite.count()).toBe(0);
  });

  it('holds four-eyes in the database, whatever the code does', async () => {
    const engagement = await createEngagement(preparer, ENGAGEMENT);
    const versionId = await confirmedVersion(engagement.id, 'en-unmodified.pdf');
    await expect(prisma.reportVersion.update({ where: { id: versionId }, data: { approvedById: preparer.id, approvedAt: new Date() } })).rejects.toThrow(/four_eyes/);
    // Nothing reaches APPROVED without an approver recorded.
    await expect(prisma.reportVersion.update({ where: { id: versionId }, data: { status: 'APPROVED' } })).rejects.toThrow(/approved_has_approver/);
  });

  it('refuses the approver when they confirmed the opinion themselves', async () => {
    const engagement = await createEngagement(preparer, ENGAGEMENT);
    const versionId = await confirmedVersion(engagement.id, 'en-unmodified.pdf');
    await prisma.reportVersion.update({ where: { id: versionId }, data: { confirmedById: approver.id } });
    await setChainWriteMode(approver, 'DRY_RUN');
    await expectCode(approveVersion(approver, versionId, TARGET), 'FOUR_EYES');
  });

  it('holds version 2 until version 1 is anchored', async () => {
    await setChainWriteMode(approver, 'DRY_RUN');
    await setChainWriteMode(approver, 'LIVE');
    const engagement = await createEngagement(preparer, ENGAGEMENT);
    const v1 = await confirmedVersion(engagement.id, 'en-unmodified.pdf');
    const v2 = await confirmedVersion(engagement.id, 'en-qualified.pdf', 'CORRECTION');
    await expectCode(approveVersion(approver, v2, TARGET), 'PREDECESSOR_NOT_ANCHORED');
    await approveVersion(approver, v1, TARGET);
    await expectCode(approveVersion(approver, v2, TARGET), 'PREDECESSOR_NOT_ANCHORED');
  });

  it('journals at most one live anchor per version', async () => {
    await setChainWriteMode(approver, 'DRY_RUN');
    const engagement = await createEngagement(preparer, ENGAGEMENT);
    const versionId = await confirmedVersion(engagement.id, 'en-unmodified.pdf');
    await approveVersion(approver, versionId, TARGET);
    const row = { reportVersionId: versionId, kind: 'ANCHOR' as const, mode: 'LIVE' as const, chainId: 1, registry: 'r', issuer: 'i' };
    await expect(prisma.chainWrite.create({ data: row })).rejects.toThrow();
    // A simulated or failed row does not count.
    await prisma.chainWrite.updateMany({ where: { reportVersionId: versionId }, data: { status: 'SIMULATED' } });
    await prisma.chainWrite.create({ data: row });
  });

  it('journals at most one write per nonce of an issuer key', async () => {
    await setChainWriteMode(approver, 'DRY_RUN');
    const a = await createEngagement(preparer, ENGAGEMENT);
    const b = await createEngagement(preparer, { ...ENGAGEMENT, engagementRef: 'ENG-2026-024' });
    const first = await approveVersion(approver, await confirmedVersion(a.id, 'en-unmodified.pdf'), TARGET);
    const second = await approveVersion(approver, await confirmedVersion(b.id, 'en-qualified.pdf'), TARGET);
    await prisma.chainWrite.update({ where: { id: first.chainWriteId }, data: { nonce: 7 } });
    await expect(prisma.chainWrite.update({ where: { id: second.chainWriteId }, data: { nonce: 7 } })).rejects.toThrow();
  });
});
