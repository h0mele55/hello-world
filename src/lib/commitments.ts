import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { Hex } from 'viem';
import { strictCanonicalJson } from './canonical-json';
import { normaliseText } from './opinion/normalise';
import { CommitmentInputError, SALT_BYTES } from './verify-core/commitment';

/**
 * The commitments a report version is anchored with. Only these 32-byte values
 * go on chain (CLAUDE.md rule 1); the inputs stay with the issuer.
 *
 *   docHash            SHA-256 of the exact file bytes
 *   familyId           HMAC-SHA256 under the issuer's secret over the family key
 *   opinionCommitment  SHA-256 over a fresh salt, the opinion type and the normalised text
 *   manifestHash       SHA-256 of the canonical manifest (see manifest.ts)
 */

export { CommitmentInputError, opinionCommitmentOf, SALT_BYTES } from './verify-core/commitment';
export const MIN_FAMILY_SECRET_BYTES = 32;

function hex(bytes: Uint8Array): Hex {
  return `0x${Buffer.from(bytes).toString('hex')}`;
}

export function sha256(bytes: Uint8Array): Hex {
  return hex(createHash('sha256').update(bytes).digest());
}

export function docHashOf(fileBytes: Uint8Array): Hex {
  return sha256(fileBytes);
}

/** A fresh salt from the operating system's CSPRNG. Never reuse one across versions. */
export function newSalt(): Uint8Array<ArrayBuffer> {
  return new Uint8Array(randomBytes(SALT_BYTES));
}

// ── Family id ──

export const REPORT_TYPES = ['STANDALONE', 'CONSOLIDATED'] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

/**
 * What makes two report versions "the same report" (#6): the client's
 * registration number (the UIC in Bulgaria), the period end, standalone or
 * consolidated, and the audit firm's own engagement reference.
 */
export interface FamilyKey {
  registrationNumber: string;
  periodEnd: string;
  reportType: ReportType;
  engagementRef: string;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isIsoDate(value: string): boolean {
  const m = ISO_DATE.exec(value);
  if (!m) return false;
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return date.toISOString().slice(0, 10) === value;
}

/**
 * The canonical family key: spacing and case in the registration number, and
 * spacing in the engagement reference, never split a family in two. Anything
 * that cannot be made canonical is refused.
 */
export function canonicalFamilyKey(key: FamilyKey): FamilyKey {
  const registrationNumber = key.registrationNumber.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z0-9-]{1,32}$/.test(registrationNumber)) {
    throw new CommitmentInputError('FAMILY_KEY_INVALID', 'registrationNumber must be 1-32 letters, digits or hyphens');
  }
  if (!isIsoDate(key.periodEnd)) {
    throw new CommitmentInputError('FAMILY_KEY_INVALID', 'periodEnd must be a real date written YYYY-MM-DD');
  }
  if (!REPORT_TYPES.includes(key.reportType)) {
    throw new CommitmentInputError('FAMILY_KEY_INVALID', `reportType must be one of ${REPORT_TYPES.join(', ')}`);
  }
  const engagementRef = normaliseText(key.engagementRef);
  if (engagementRef.length < 1 || engagementRef.length > 64) {
    throw new CommitmentInputError('FAMILY_KEY_INVALID', 'engagementRef must be 1-64 characters');
  }
  return { registrationNumber, periodEnd: key.periodEnd, reportType: key.reportType, engagementRef };
}

/**
 * familyId = HMAC-SHA256(secret, canonical JSON of { v: 1, ...family key }).
 * Keyed, so nobody without the issuer's secret can test a guessed client and
 * period against the chain. `v` versions the derivation: a different key
 * layout must never produce an id that collides with this one.
 */
export function familyIdOf(secret: Uint8Array, key: FamilyKey): Hex {
  if (secret.length < MIN_FAMILY_SECRET_BYTES) {
    throw new CommitmentInputError('FAMILY_SECRET_TOO_SHORT', `the family secret must be at least ${MIN_FAMILY_SECRET_BYTES} bytes`);
  }
  const preimage = strictCanonicalJson({ v: 1, ...canonicalFamilyKey(key) });
  return hex(createHmac('sha256', secret).update(preimage, 'utf8').digest());
}
