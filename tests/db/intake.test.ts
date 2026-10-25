import fs from 'node:fs';
import path from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { SessionUser } from '@/auth';
import { PrismaClient } from '@/generated/prisma/client';
import { docHashOf, opinionCommitmentOf } from '@/lib/commitments';
import { sealingKeys } from '@/lib/keys';
import { manifestHashOf, parseManifest } from '@/lib/manifest';
import { normaliseText } from '@/lib/opinion/normalise';
import { open } from '@/lib/sealed';
import { readStoredFile } from '@/lib/storage';
import { confirmOpinion, createEngagement, discardDraft, getVersion, IntakeError, readVersionFile, uploadVersion, type NewEngagement } from '@/lib/reports/intake';
import { REPORTS } from '../fixtures/pdf/reports';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
const fixture = (name: string) => fs.readFileSync(path.join(import.meta.dirname, '..', 'fixtures', 'pdf', name));

let preparer: SessionUser;
let approver: SessionUser;
let outsider: SessionUser;

const ENGAGEMENT: NewEngagement = {
  clientName: 'Example Manufacturing AD',
  registrationNumber: '123 456 789',
  country: 'bg',
  engagementRef: 'ENG-2026-014',
  periodEnd: '2025-12-31',
  reportType: 'STANDALONE',
};

async function expectIntakeError(promise: Promise<unknown>, code: string, detail?: string) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(IntakeError);
  expect((error as IntakeError).code).toBe(code);
  if (detail) expect((error as IntakeError).detail).toBe(detail);
}

beforeEach(async () => {
  fs.rmSync(process.env.FILE_STORAGE_DIR!, { recursive: true, force: true });
  await prisma.$executeRawUnsafe('TRUNCATE "ReportVersion", "StoredFile", "Engagement", "Client", "User", "IssuerOrg" CASCADE');
  const org = await prisma.issuerOrg.create({ data: { name: 'Example Audit OOD' } });
  const other = await prisma.issuerOrg.create({ data: { name: 'Another Firm' } });
  const make = async (orgId: string, email: string, role: 'PREPARER' | 'APPROVER'): Promise<SessionUser> => {
    const user = await prisma.user.create({ data: { orgId, email, name: email, role, passwordHash: 'x' } });
    return { id: user.id, email, name: email, role, orgId };
  };
  preparer = await make(org.id, 'preparer@example.test', 'PREPARER');
  approver = await make(org.id, 'approver@example.test', 'APPROVER');
  outsider = await make(other.id, 'outsider@example.test', 'PREPARER');
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('engagements', () => {
  it('a preparer creates one, with the family id derived from the canonical key', async () => {
    const engagement = await createEngagement(preparer, ENGAGEMENT);
    expect(engagement.familyId).toMatch(/^0x[0-9a-f]{64}$/);
    const client = await prisma.client.findUniqueOrThrow({ where: { id: engagement.clientId } });
    expect(client).toMatchObject({ registrationNumber: '123456789', country: 'BG' });
  });

  it('refuses an approver, a duplicate, and input that cannot be canonical', async () => {
    await expectIntakeError(createEngagement(approver, ENGAGEMENT), 'FORBIDDEN');
    await createEngagement(preparer, ENGAGEMENT);
    await expectIntakeError(createEngagement(preparer, { ...ENGAGEMENT, registrationNumber: '123456789' }), 'ENGAGEMENT_EXISTS');
    await expectIntakeError(createEngagement(preparer, { ...ENGAGEMENT, periodEnd: '2025-02-30' }), 'INVALID_INPUT');
    await expectIntakeError(createEngagement(preparer, { ...ENGAGEMENT, country: 'Bulgaria' }), 'INVALID_INPUT');
  });

  it('keeps standalone and consolidated reports apart (#6)', async () => {
    const standalone = await createEngagement(preparer, ENGAGEMENT);
    const consolidated = await createEngagement(preparer, { ...ENGAGEMENT, reportType: 'CONSOLIDATED' });
    expect(standalone.familyId).not.toBe(consolidated.familyId);
    expect(standalone.clientId).toBe(consolidated.clientId);
  });
});

describe('upload', () => {
  it('stores the file encrypted, finds the opinion, and opens a draft', async () => {
    const engagement = await createEngagement(preparer, ENGAGEMENT);
    const bytes = fixture('en-qualified.pdf');
    const uploaded = await uploadVersion(preparer, { engagementId: engagement.id, reasonCode: 'INITIAL', bytes });
    expect(uploaded).toMatchObject({ version: 1, docHash: docHashOf(bytes), anchorOnly: false });
    expect(uploaded.extraction).toMatchObject({ status: 'FOUND', type: 'QUALIFIED' });

    const row = await prisma.reportVersion.findUniqueOrThrow({ where: { id: uploaded.id }, include: { storedFile: true } });
    expect(row.status).toBe('DRAFT');
    // On disk it is ciphertext; decrypted it is byte-for-byte the upload.
    const onDisk = fs.readFileSync(path.join(process.env.FILE_STORAGE_DIR!, row.storedFile.path));
    expect(onDisk.includes(Buffer.from('%PDF'))).toBe(false);
    expect(Buffer.from(await readStoredFile(row.storedFile)).equals(bytes)).toBe(true);
    expect(Buffer.from(await readVersionFile(approver, uploaded.id)).equals(bytes)).toBe(true);
  });

  it('marks a signed PDF anchor-only', async () => {
    const engagement = await createEngagement(preparer, ENGAGEMENT);
    const uploaded = await uploadVersion(preparer, { engagementId: engagement.id, reasonCode: 'INITIAL', bytes: fixture('en-signed.pdf') });
    expect(uploaded.anchorOnly).toBe(true);
    expect(uploaded.flags.signed).toBe(true);
  });

  it('refuses with the parser’s named reason and writes nothing', async () => {
    const engagement = await createEngagement(preparer, ENGAGEMENT);
    await expectIntakeError(uploadVersion(preparer, { engagementId: engagement.id, reasonCode: 'INITIAL', bytes: Buffer.from('<html>') }), 'PDF_REFUSED', 'NOT_A_PDF');
    const bytes = fixture('en-unmodified.pdf');
    await expectIntakeError(uploadVersion(preparer, { engagementId: engagement.id, reasonCode: 'INITIAL', bytes: bytes.subarray(0, 5000) }), 'PDF_REFUSED', 'TRUNCATED');
    expect(await prisma.reportVersion.count()).toBe(0);
    expect(await prisma.storedFile.count()).toBe(0);
  });

  it('refuses the same file twice, a second draft, and a wrong reason code', async () => {
    const first = await createEngagement(preparer, ENGAGEMENT);
    const second = await createEngagement(preparer, { ...ENGAGEMENT, engagementRef: 'ENG-2026-015' });
    const bytes = fixture('en-unmodified.pdf');
    await expectIntakeError(uploadVersion(preparer, { engagementId: first.id, reasonCode: 'CORRECTION', bytes }), 'INVALID_INPUT');
    await uploadVersion(preparer, { engagementId: first.id, reasonCode: 'INITIAL', bytes });
    await expectIntakeError(uploadVersion(preparer, { engagementId: first.id, reasonCode: 'CORRECTION', bytes: fixture('en-adverse.pdf') }), 'DRAFT_PENDING');
    await expectIntakeError(uploadVersion(preparer, { engagementId: second.id, reasonCode: 'INITIAL', bytes }), 'DOC_ALREADY_UPLOADED');
    // A refused upload leaves no file behind.
    expect(fs.readdirSync(process.env.FILE_STORAGE_DIR!)).toHaveLength(await prisma.storedFile.count());
  });

  it('refuses an approver and anyone outside the firm', async () => {
    const engagement = await createEngagement(preparer, ENGAGEMENT);
    const bytes = fixture('en-unmodified.pdf');
    await expectIntakeError(uploadVersion(approver, { engagementId: engagement.id, reasonCode: 'INITIAL', bytes }), 'FORBIDDEN');
    await expectIntakeError(uploadVersion(outsider, { engagementId: engagement.id, reasonCode: 'INITIAL', bytes }), 'NOT_FOUND');
    const uploaded = await uploadVersion(preparer, { engagementId: engagement.id, reasonCode: 'INITIAL', bytes });
    await expectIntakeError(getVersion(outsider, uploaded.id), 'NOT_FOUND');
    await expectIntakeError(readVersionFile(outsider, uploaded.id), 'NOT_FOUND');
  });
});

describe('confirmation (rule 6)', () => {
  const report = REPORTS.find((r) => r.file === 'bg-qualified.pdf')!;

  async function draft() {
    const engagement = await createEngagement(preparer, ENGAGEMENT);
    return uploadVersion(preparer, { engagementId: engagement.id, reasonCode: 'INITIAL', bytes: fixture(report.file) });
  }

  it('commits to exactly the text and type the person confirmed', async () => {
    const uploaded = await draft();
    const corrected = `${normaliseText(report.opinion.join(' '))} (corrected by hand)`;
    const result = await confirmOpinion(preparer, { versionId: uploaded.id, opinionType: 'ADVERSE', text: `  ${corrected}\n`, reportDate: '2026-03-20' });

    const row = await prisma.reportVersion.findUniqueOrThrow({ where: { id: uploaded.id } });
    expect(row.status).toBe('CONFIRMED');
    expect(row.opinionType).toBe('ADVERSE');
    expect(row.confirmedById).toBe(preparer.id);
    const confirmed = new TextDecoder().decode(open(sealingKeys(), row.confirmedOpinion!, `report-version:${row.docHash}:confirmedOpinion`));
    expect(confirmed).toBe(corrected);
    expect(row.opinionCommitment).toBe(opinionCommitmentOf({ salt: row.opinionSalt!, type: 'ADVERSE', text: corrected }));
    expect(result.opinionCommitment).toBe(row.opinionCommitment);

    const manifest = parseManifest(JSON.parse(new TextDecoder().decode(open(sealingKeys(), row.manifest!, `report-version:${row.docHash}:manifest`))));
    expect(manifest).toMatchObject({ version: 1, reasonCode: 'INITIAL', docHash: row.docHash, opinionType: 'ADVERSE', opinionCommitment: row.opinionCommitment, reportDate: '2026-03-20' });
    expect(manifestHashOf(manifest)).toBe(row.manifestHash);
    expect(manifest.manifestSalt).toBe(`0x${Buffer.from(row.manifestSalt!).toString('hex')}`);

    const view = await getVersion(approver, uploaded.id);
    expect(view).toMatchObject({ status: 'CONFIRMED', confirmedOpinion: corrected, opinionType: 'ADVERSE' });
  });

  it('runs once, only for a preparer, and never for an empty text or a bad date', async () => {
    const uploaded = await draft();
    const confirmation = { versionId: uploaded.id, opinionType: 'QUALIFIED' as const, text: 'Some opinion.', reportDate: '2026-03-20' };
    await expectIntakeError(confirmOpinion(approver, confirmation), 'FORBIDDEN');
    await expectIntakeError(confirmOpinion(preparer, { ...confirmation, text: '  \n ' }), 'INVALID_INPUT');
    await expectIntakeError(confirmOpinion(preparer, { ...confirmation, reportDate: '20.03.2026' }), 'INVALID_INPUT');
    expect((await prisma.reportVersion.findUniqueOrThrow({ where: { id: uploaded.id } })).status).toBe('DRAFT');
    await confirmOpinion(preparer, confirmation);
    await expectIntakeError(confirmOpinion(preparer, confirmation), 'NOT_DRAFT');
  });

  it('two confirmations racing each other: exactly one wins', async () => {
    const uploaded = await draft();
    const confirmation = { versionId: uploaded.id, opinionType: 'QUALIFIED' as const, text: 'Some opinion.', reportDate: '2026-03-20' };
    const results = await Promise.allSettled([confirmOpinion(preparer, confirmation), confirmOpinion(preparer, confirmation)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('a sealed field copied into another row does not open there', async () => {
    const engagement = await createEngagement(preparer, ENGAGEMENT);
    const a = await uploadVersion(preparer, { engagementId: engagement.id, reasonCode: 'INITIAL', bytes: fixture('en-unmodified.pdf') });
    const other = await createEngagement(preparer, { ...ENGAGEMENT, engagementRef: 'ENG-2026-015' });
    const b = await uploadVersion(preparer, { engagementId: other.id, reasonCode: 'INITIAL', bytes: fixture('en-adverse.pdf') });
    const rowA = await prisma.reportVersion.findUniqueOrThrow({ where: { id: a.id } });
    await prisma.reportVersion.update({ where: { id: b.id }, data: { extraction: rowA.extraction } });
    await expect(getVersion(preparer, b.id)).rejects.toThrow(/AUTH_FAILED/);
  });
});

describe('discarding a draft', () => {
  it('removes the version and its file, and only while it is a draft', async () => {
    const engagement = await createEngagement(preparer, ENGAGEMENT);
    const uploaded = await uploadVersion(preparer, { engagementId: engagement.id, reasonCode: 'INITIAL', bytes: fixture('en-unmodified.pdf') });
    await discardDraft(preparer, uploaded.id);
    expect(await prisma.reportVersion.count()).toBe(0);
    expect(fs.readdirSync(process.env.FILE_STORAGE_DIR!)).toEqual([]);

    const again = await uploadVersion(preparer, { engagementId: engagement.id, reasonCode: 'INITIAL', bytes: fixture('en-unmodified.pdf') });
    await confirmOpinion(preparer, { versionId: again.id, opinionType: 'UNMODIFIED', text: 'x', reportDate: '2026-03-20' });
    await expectIntakeError(discardDraft(preparer, again.id), 'NOT_DRAFT');
  });
});
