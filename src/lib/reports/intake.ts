import 'server-only';
import type { SessionUser } from '@/auth';
import { Prisma } from '@/generated/prisma/client';
import type { OpinionType, ReasonCode, ReportType } from '@/generated/prisma/enums';
import { canonicalFamilyKey, CommitmentInputError, docHashOf, familyIdOf, isIsoDate, newSalt, opinionCommitmentOf } from '@/lib/commitments';
import { db } from '@/lib/db';
import { currentSealingKey, sealingKeys } from '@/lib/keys';
import { buildManifest, canonicalManifest, manifestHashOf } from '@/lib/manifest';
import { locateOpinion, type LocateResult } from '@/lib/opinion/locate';
import { dropRunningLines, normaliseText } from '@/lib/opinion/normalise';
import { parsePdf, type PdfFlags, type PdfRefusal } from '@/lib/pdf/parse';
import { open, openJson, seal, sealJson } from '@/lib/sealed';
import { serverEnv } from '@/lib/server-env';
import { discardStoredFile, readStoredFile, storeFile } from '@/lib/storage';

/**
 * Taking a report in: an engagement (the report family), an uploaded version,
 * and the opinion a person confirms. Every function checks the caller's role
 * and organisation itself and fails with a named IntakeError (CLAUDE.md
 * rule 7). Nothing here writes to a chain.
 */

export type IntakeErrorCode =
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'INVALID_INPUT'
  | 'PDF_REFUSED'
  | 'DOC_ALREADY_UPLOADED'
  | 'ENGAGEMENT_EXISTS'
  | 'DRAFT_PENDING'
  | 'VERSION_CONFLICT'
  | 'NOT_DRAFT';

export class IntakeError extends Error {
  constructor(
    readonly code: IntakeErrorCode,
    readonly detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'IntakeError';
  }
}

function requirePreparer(user: SessionUser) {
  if (user.role !== 'PREPARER') throw new IntakeError('FORBIDDEN', 'only a preparer may do this');
}

const isUniqueViolation = (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

const extractionContext = (docHash: string) => `report-version:${docHash}:extraction`;
const opinionContext = (docHash: string) => `report-version:${docHash}:confirmedOpinion`;
const manifestContext = (docHash: string) => `report-version:${docHash}:manifest`;

// ── Engagements ──

export interface NewEngagement {
  clientName: string;
  registrationNumber: string;
  country: string;
  engagementRef: string;
  periodEnd: string;
  reportType: ReportType;
}

export async function createEngagement(user: SessionUser, input: NewEngagement) {
  requirePreparer(user);
  const clientName = normaliseText(input.clientName);
  const country = input.country.trim().toUpperCase();
  if (clientName.length < 1 || clientName.length > 200) throw new IntakeError('INVALID_INPUT', 'clientName');
  if (!/^[A-Z]{2}$/.test(country)) throw new IntakeError('INVALID_INPUT', 'country');
  let key;
  try {
    key = canonicalFamilyKey(input);
  } catch (error) {
    if (error instanceof CommitmentInputError) throw new IntakeError('INVALID_INPUT', error.message);
    throw error;
  }
  const familyId = familyIdOf(serverEnv().ISSUER_FAMILY_SECRET, key);

  return db().$transaction(async (tx) => {
    const client = await tx.client.upsert({
      where: { orgId_country_registrationNumber: { orgId: user.orgId, country, registrationNumber: key.registrationNumber } },
      create: { orgId: user.orgId, name: clientName, country, registrationNumber: key.registrationNumber },
      update: {},
    });
    try {
      return await tx.engagement.create({
        data: {
          clientId: client.id,
          engagementRef: key.engagementRef,
          periodEnd: new Date(`${key.periodEnd}T00:00:00Z`),
          reportType: key.reportType,
          familyId,
          createdById: user.id,
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new IntakeError('ENGAGEMENT_EXISTS');
      throw error;
    }
  });
}

async function engagementInOrg(user: SessionUser, engagementId: string) {
  const engagement = await db().engagement.findFirst({ where: { id: engagementId, client: { orgId: user.orgId } } });
  if (!engagement) throw new IntakeError('NOT_FOUND');
  return engagement;
}

// ── Upload ──

export interface UploadedVersion {
  id: string;
  version: number;
  docHash: string;
  anchorOnly: boolean;
  flags: PdfFlags;
  extraction: LocateResult;
}

export async function uploadVersion(user: SessionUser, input: { engagementId: string; reasonCode: ReasonCode; bytes: Uint8Array }): Promise<UploadedVersion> {
  requirePreparer(user);
  const engagement = await engagementInOrg(user, input.engagementId);

  const parsed = await parsePdf(input.bytes);
  if (!parsed.ok) throw new IntakeError('PDF_REFUSED', parsed.reason satisfies PdfRefusal);
  const docHash = docHashOf(input.bytes);

  const existing = await db().reportVersion.findMany({ where: { engagementId: engagement.id }, select: { version: true, status: true }, orderBy: { version: 'desc' } });
  if (existing.some((v) => v.status === 'DRAFT')) throw new IntakeError('DRAFT_PENDING');
  const version = (existing[0]?.version ?? 0) + 1;
  if ((version === 1) !== (input.reasonCode === 'INITIAL')) throw new IntakeError('INVALID_INPUT', 'version 1, and only version 1, has reasonCode INITIAL');

  const extraction = locateOpinion(dropRunningLines(parsed.pdf.pages.map((page) => page.lines.map((line) => line.text))));
  const { flags } = parsed.pdf;
  const anchorOnly = flags.signed || flags.editProtected;
  const key = currentSealingKey();

  const stored = await storeFile(input.bytes);
  try {
    const created = await db().reportVersion.create({
      data: {
        engagement: { connect: { id: engagement.id } },
        version,
        reasonCode: input.reasonCode,
        docHash,
        pageCount: parsed.pdf.pageCount,
        anchorOnly,
        flags,
        extraction: sealJson(key, extraction, extractionContext(docHash)),
        preparedBy: { connect: { id: user.id } },
        storedFile: {
          create: { path: stored.path, iv: stored.iv, authTag: stored.authTag, keyVersion: stored.keyVersion, sha256: stored.sha256, size: stored.size },
        },
      },
      select: { id: true },
    });
    return { id: created.id, version, docHash, anchorOnly, flags, extraction };
  } catch (error) {
    await discardStoredFile(stored.path);
    if (isUniqueViolation(error)) {
      // The driver adapter does not say which constraint fired, so ask: the
      // same file already stored, or another upload took this version number.
      const duplicate = await db().reportVersion.findUnique({ where: { docHash }, select: { id: true } });
      throw new IntakeError(duplicate ? 'DOC_ALREADY_UPLOADED' : 'VERSION_CONFLICT');
    }
    throw error;
  }
}

// ── Reads ──

async function versionInOrg(user: SessionUser, versionId: string) {
  const version = await db().reportVersion.findFirst({
    where: { id: versionId, engagement: { client: { orgId: user.orgId } } },
    include: { engagement: { include: { client: true } }, storedFile: true },
  });
  if (!version) throw new IntakeError('NOT_FOUND');
  return version;
}

export async function getVersion(user: SessionUser, versionId: string) {
  const version = await versionInOrg(user, versionId);
  const keys = sealingKeys();
  return {
    id: version.id,
    version: version.version,
    reasonCode: version.reasonCode,
    status: version.status,
    docHash: version.docHash,
    pageCount: version.pageCount,
    anchorOnly: version.anchorOnly,
    flags: version.flags as PdfFlags,
    extraction: openJson<LocateResult>(keys, version.extraction, extractionContext(version.docHash)),
    opinionType: version.opinionType,
    confirmedOpinion: version.confirmedOpinion ? new TextDecoder().decode(open(keys, version.confirmedOpinion, opinionContext(version.docHash))) : null,
    reportDate: version.reportDate?.toISOString().slice(0, 10) ?? null,
    opinionCommitment: version.opinionCommitment,
    manifestHash: version.manifestHash,
    confirmedAt: version.confirmedAt,
    engagement: {
      id: version.engagement.id,
      engagementRef: version.engagement.engagementRef,
      periodEnd: version.engagement.periodEnd.toISOString().slice(0, 10),
      reportType: version.engagement.reportType,
      clientName: version.engagement.client.name,
    },
  };
}

export async function readVersionFile(user: SessionUser, versionId: string): Promise<Uint8Array> {
  const version = await versionInOrg(user, versionId);
  return readStoredFile(version.storedFile);
}

// ── Confirmation (CLAUDE.md rule 6) ──

export interface Confirmation {
  versionId: string;
  opinionType: OpinionType;
  /** The opinion text as the person confirmed or corrected it. */
  text: string;
  /** The date of the auditor's report, YYYY-MM-DD. */
  reportDate: string;
}

/**
 * Commits to the opinion a person has confirmed: fresh salts, the opinion
 * commitment over exactly the confirmed (normalised) text, and manifest v1.
 * The only path from DRAFT to CONFIRMED, and it runs once: the update is
 * conditional on the version still being a draft.
 */
export async function confirmOpinion(user: SessionUser, input: Confirmation) {
  requirePreparer(user);
  const version = await versionInOrg(user, input.versionId);
  if (version.status !== 'DRAFT') throw new IntakeError('NOT_DRAFT');
  const text = normaliseText(input.text);
  if (text === '' || text.length > 8000) throw new IntakeError('INVALID_INPUT', 'text');
  if (!isIsoDate(input.reportDate)) throw new IntakeError('INVALID_INPUT', 'reportDate');

  const opinionSalt = newSalt();
  const manifestSalt = newSalt();
  const opinionCommitment = opinionCommitmentOf({ salt: opinionSalt, type: input.opinionType, text });
  const manifest = buildManifest({
    familyId: version.engagement.familyId as `0x${string}`,
    version: version.version,
    reasonCode: version.reasonCode,
    docHash: version.docHash as `0x${string}`,
    pageCount: version.pageCount,
    reportDate: input.reportDate,
    opinionType: input.opinionType,
    opinionCommitment,
    manifestSalt: `0x${Buffer.from(manifestSalt).toString('hex')}`,
  });
  const key = currentSealingKey();

  const updated = await db().reportVersion.updateMany({
    where: { id: version.id, status: 'DRAFT' },
    data: {
      status: 'CONFIRMED',
      opinionType: input.opinionType,
      confirmedOpinion: seal(key, new TextEncoder().encode(text), opinionContext(version.docHash)),
      reportDate: new Date(`${input.reportDate}T00:00:00Z`),
      opinionSalt,
      opinionCommitment,
      manifestSalt,
      manifest: seal(key, new TextEncoder().encode(canonicalManifest(manifest)), manifestContext(version.docHash)),
      manifestHash: manifestHashOf(manifest),
      confirmedById: user.id,
      confirmedAt: new Date(),
    },
  });
  if (updated.count !== 1) throw new IntakeError('NOT_DRAFT');
  return { opinionCommitment, manifestHash: manifestHashOf(manifest) };
}

/** Deletes a draft and its stored file, so a wrong upload does not block the family. */
export async function discardDraft(user: SessionUser, versionId: string) {
  requirePreparer(user);
  const version = await versionInOrg(user, versionId);
  const deleted = await db().$transaction(async (tx) => {
    const { count } = await tx.reportVersion.deleteMany({ where: { id: version.id, status: 'DRAFT' } });
    if (count !== 1) return false;
    await tx.storedFile.delete({ where: { id: version.storedFileId } });
    return true;
  });
  if (!deleted) throw new IntakeError('NOT_DRAFT');
  await discardStoredFile(version.storedFile.path);
}
