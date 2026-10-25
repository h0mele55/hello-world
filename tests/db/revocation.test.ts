import fs from 'node:fs';
import path from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { SessionUser } from '@/auth';
import { PrismaClient } from '@/generated/prisma/client';
import { approveVersion, setChainWriteMode } from '@/lib/anchoring/approve';
import { AnchoringError } from '@/lib/anchoring/errors';
import { approveRevocation, getRevocations, rejectRevocation, requestRevocation, withdrawRevocation } from '@/lib/anchoring/revocation';
import type { AnchorTarget } from '@/lib/anchoring/target';
import { verifyAuditChain } from '@/lib/audit';
import { AccessError } from '@/lib/roles';
import { confirmOpinion, createEngagement, uploadVersion } from '@/lib/reports/intake';

/**
 * Asking for and approving a revocation (Phase 5, #55): who may, what they
 * must type, four eyes in the use case and in the database, one open request
 * per version, and the note kept sealed.
 */

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
const fixture = (name: string) => fs.readFileSync(path.join(import.meta.dirname, '..', 'fixtures', 'pdf', name));
const TARGET: AnchorTarget = { network: 'local', chainId: 31337, registry: '0x5FbDB2315678afecb367f032d93F642f64180aa3', issuer: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' };
const REF = 'ENG-2026-040';
const NOTE = 'Issued against the wrong reporting period.';

let preparer: SessionUser;
let approver: SessionUser;
let admin: SessionUser;
let secondAdmin: SessionUser;
let outsider: SessionUser;

async function expectCode(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AnchoringError);
  expect((error as AnchoringError).code).toBe(code);
}

beforeEach(async () => {
  fs.rmSync(process.env.FILE_STORAGE_DIR!, { recursive: true, force: true });
  await prisma.$executeRawUnsafe('TRUNCATE "Revocation", "ChainWrite", "AuditEvent", "ReportVersion", "StoredFile", "Engagement", "Client", "User", "IssuerOrg" CASCADE');
  const org = await prisma.issuerOrg.create({ data: { name: 'Example Audit OOD' } });
  const other = await prisma.issuerOrg.create({ data: { name: 'Another Firm' } });
  const make = async (org: string, email: string, role: 'PREPARER' | 'APPROVER' | 'ADMIN'): Promise<SessionUser> => {
    const user = await prisma.user.create({ data: { orgId: org, email, name: email, role, passwordHash: 'x' } });
    return { id: user.id, email, name: email, role, orgId: org, mfa: role === 'PREPARER' ? 'NOT_REQUIRED' : 'VERIFIED' };
  };
  preparer = await make(org.id, 'preparer@example.test', 'PREPARER');
  approver = await make(org.id, 'approver@example.test', 'APPROVER');
  admin = await make(org.id, 'admin@example.test', 'ADMIN');
  secondAdmin = await make(org.id, 'admin2@example.test', 'ADMIN');
  outsider = await make(other.id, 'outsider@example.test', 'ADMIN');
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** A version whose original is anchored, as the worker leaves it (the worker itself is tested against a chain). */
async function anchoredVersion() {
  const engagement = await createEngagement(preparer, { clientName: 'Example Manufacturing AD', registrationNumber: '123456789', country: 'BG', engagementRef: REF, periodEnd: '2025-12-31', reportType: 'STANDALONE' });
  const uploaded = await uploadVersion(preparer, { engagementId: engagement.id, reasonCode: 'INITIAL', bytes: fixture('en-unmodified.pdf') });
  await confirmOpinion(preparer, { versionId: uploaded.id, opinionType: 'UNMODIFIED', text: 'In our opinion, the financial statements present fairly.', reportDate: '2026-03-31' });
  await setChainWriteMode(approver, 'DRY_RUN');
  await setChainWriteMode(approver, 'LIVE');
  const { chainWriteId } = await approveVersion(approver, uploaded.id, TARGET);
  await prisma.chainWrite.update({ where: { id: chainWriteId }, data: { status: 'FINAL', recordId: `0x${'1'.repeat(64)}`, blockNumber: 10n } });
  await prisma.reportVersion.update({ where: { id: uploaded.id }, data: { status: 'ANCHORED', recordId: `0x${'1'.repeat(64)}`, anchorBlock: 10n } });
  return uploaded.id;
}

const request = (versionId: string, user = admin) => requestRevocation(user, { versionId, reason: 'ISSUED_IN_ERROR', note: NOTE, confirmation: REF });

describe('asking for a revocation', () => {
  it('is for an admin who types the engagement’s reference, and only for an anchored version', async () => {
    const versionId = await anchoredVersion();
    await expect(request(versionId, preparer)).rejects.toBeInstanceOf(AccessError);
    await expect(request(versionId, approver)).rejects.toBeInstanceOf(AccessError);
    await expectCode(requestRevocation(admin, { versionId, reason: 'OTHER', note: NOTE, confirmation: 'ENG-2026-041' }), 'CONFIRMATION_MISMATCH');
    await expectCode(request(versionId, outsider), 'NOT_FOUND');

    const draft = await uploadVersion(preparer, { engagementId: (await prisma.reportVersion.findUniqueOrThrow({ where: { id: versionId } })).engagementId, reasonCode: 'CORRECTION', bytes: fixture('en-qualified.pdf') });
    await expectCode(request(draft.id), 'NOT_REVOCABLE');

    const { revocationId } = await request(versionId);
    expect(await prisma.revocation.findUniqueOrThrow({ where: { id: revocationId } })).toMatchObject({ status: 'REQUESTED', reason: 'ISSUED_IN_ERROR', requestedById: admin.id });
  });

  it('keeps the note sealed, and opens it only for the firm', async () => {
    const versionId = await anchoredVersion();
    const { revocationId } = await request(versionId);
    const row = await prisma.revocation.findUniqueOrThrow({ where: { id: revocationId } });
    expect(Buffer.from(row.note).toString('latin1')).not.toContain('reporting period');
    expect(await getRevocations(admin, versionId)).toEqual([expect.objectContaining({ id: revocationId, note: NOTE, code: 2, status: 'REQUESTED', requestedBy: admin.email })]);
    expect(await getRevocations(outsider, versionId)).toEqual([]);
  });

  it('allows one open request per version; a closed one makes room for the next', async () => {
    const versionId = await anchoredVersion();
    const first = await request(versionId);
    await expectCode(request(versionId, secondAdmin), 'REVOCATION_OPEN');

    // Only the admin who asked may take it back.
    await expectCode(withdrawRevocation(secondAdmin, first.revocationId), 'NOT_FOUND');
    await withdrawRevocation(admin, first.revocationId);
    await expectCode(withdrawRevocation(admin, first.revocationId), 'NOT_REQUESTED');

    const second = await request(versionId, secondAdmin);
    await expect(rejectRevocation(admin, second.revocationId)).rejects.toBeInstanceOf(AccessError);
    await rejectRevocation(approver, second.revocationId);
    expect(await prisma.revocation.findUniqueOrThrow({ where: { id: second.revocationId } })).toMatchObject({ status: 'REJECTED', closedById: approver.id });
    await request(versionId);
  });
});

describe('approving a revocation', () => {
  it('needs an approver, queues one REVOKE write, and is written to the audit log', async () => {
    const versionId = await anchoredVersion();
    const { revocationId } = await request(versionId);
    await expect(approveRevocation(admin, revocationId, TARGET)).rejects.toBeInstanceOf(AccessError);
    await expectCode(approveRevocation(approver, revocationId, null), 'CHAIN_NOT_CONFIGURED');

    const { chainWriteId, mode } = await approveRevocation(approver, revocationId, TARGET);
    expect(mode).toBe('LIVE');
    expect(await prisma.chainWrite.findUniqueOrThrow({ where: { id: chainWriteId } })).toMatchObject({ kind: 'REVOKE', status: 'INTENT', recordId: `0x${'1'.repeat(64)}` });
    expect(await prisma.revocation.findUniqueOrThrow({ where: { id: revocationId } })).toMatchObject({ status: 'APPROVED', approvedById: approver.id });
    await expectCode(approveRevocation(approver, revocationId, TARGET), 'NOT_REQUESTED');
    await expectCode(rejectRevocation(approver, revocationId), 'NOT_REQUESTED');

    const actions = (await prisma.auditEvent.findMany({ where: { subjectId: revocationId }, orderBy: { seq: 'asc' } })).map((e) => e.action);
    expect(actions).toEqual(['revocation.requested', 'revocation.approved']);
    expect(await verifyAuditChain(prisma, admin.orgId)).toMatchObject({ ok: true });
  });

  it('is refused while chain writes are disabled', async () => {
    const versionId = await anchoredVersion();
    const { revocationId } = await request(versionId);
    await setChainWriteMode(approver, 'DRY_RUN');
    await setChainWriteMode(approver, 'DISABLED');
    await expectCode(approveRevocation(approver, revocationId, TARGET), 'CHAIN_WRITES_DISABLED');
  });

  it('keeps a scheduled revocation open, frees the version once the owner cancels it, and journals one REVOKE at a time (#95)', async () => {
    const versionId = await anchoredVersion();
    const first = await request(versionId);
    const { chainWriteId } = await approveRevocation(approver, first.revocationId, TARGET);
    // What the worker records once the REVOKE is final: the request now waits out the registry's delay.
    await prisma.chainWrite.update({ where: { id: chainWriteId }, data: { status: 'FINAL', blockNumber: 12n } });
    const at = (iso: string) => new Date(iso);
    await expect(prisma.revocation.update({ where: { id: first.revocationId }, data: { status: 'SCHEDULED' } })).rejects.toThrow(/Revocation_scheduled_has_time/);
    await prisma.revocation.update({ where: { id: first.revocationId }, data: { status: 'SCHEDULED', effectiveAt: at('2026-10-26T09:00:00Z') } });
    await expectCode(request(versionId, secondAdmin), 'REVOCATION_OPEN');
    expect((await getRevocations(admin, versionId))[0]).toMatchObject({ status: 'SCHEDULED', effectiveAt: '2026-10-26T09:00:00.000Z' });

    // The owner cancelled it on chain: nobody in the firm closed it.
    await expect(
      prisma.revocation.update({ where: { id: first.revocationId }, data: { status: 'CANCELLED', closedAt: new Date(), closedById: admin.id } }),
    ).rejects.toThrow(/Revocation_cancelled_has_time/);
    await prisma.revocation.update({ where: { id: first.revocationId }, data: { status: 'CANCELLED', closedAt: new Date() } });

    // The firm may ask again, and a second REVOKE is journalled beside the first, final one.
    const second = await request(versionId, secondAdmin);
    const again = await approveRevocation(approver, second.revocationId, TARGET);
    expect(await prisma.chainWrite.count({ where: { reportVersionId: versionId, kind: 'REVOKE' } })).toBe(2);
    // But never two in flight at once.
    await expect(
      prisma.chainWrite.create({ data: { orgId: approver.orgId, reportVersionId: versionId, kind: 'REVOKE', mode: 'LIVE', chainId: TARGET.chainId, registry: TARGET.registry, issuer: TARGET.issuer } }),
    ).rejects.toThrow();
    expect((await prisma.chainWrite.findUniqueOrThrow({ where: { id: again.chainWriteId } })).status).toBe('INTENT');
  });

  it('holds four eyes in the database too: whoever asked never approves', async () => {
    const versionId = await anchoredVersion();
    const { revocationId } = await request(versionId);
    await expect(
      prisma.revocation.update({ where: { id: revocationId }, data: { status: 'APPROVED', approvedById: admin.id, approvedAt: new Date() } }),
    ).rejects.toThrow(/Revocation_four_eyes/);
    await expect(prisma.revocation.update({ where: { id: revocationId }, data: { status: 'APPROVED' } })).rejects.toThrow(/Revocation_approved_has_approver/);
  });
});
