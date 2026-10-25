import type { Hex } from 'viem';
import { z } from 'zod';
import { strictCanonicalJson } from './canonical-json';
import { isIsoDate, sha256 } from './commitments';
import { NORMALISER_VERSION } from './opinion/normalise';
import { OPINION_TYPES } from './opinion/types';

/**
 * Manifest v1: the off-chain record of one report version, committed to on
 * chain by `manifestHash` = SHA-256 of its canonical JSON. It carries its own
 * fresh salt, so the hash reveals nothing about its fields.
 *
 * `schema` and `norm` version the layout and the opinion normaliser. A reader
 * refuses a version it does not know rather than guessing what an old or newer
 * manifest meant (CLAUDE.md rule 7).
 */
export const MANIFEST_SCHEMA_VERSION = 1;

export const REASON_CODES = ['INITIAL', 'CORRECTION', 'SUBSEQUENT_EVENT', 'OTHER'] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

const bytes32 = z.string().regex(/^0x[0-9a-f]{64}$/, 'a lower-case 0x-prefixed 32-byte hex string');

const ManifestV1 = z
  .strictObject({
    schema: z.literal(MANIFEST_SCHEMA_VERSION),
    norm: z.literal(NORMALISER_VERSION),
    familyId: bytes32,
    version: z.int().min(1).max(0xffffffff),
    reasonCode: z.enum(REASON_CODES),
    docHash: bytes32,
    pageCount: z.int().min(1).max(500),
    reportDate: z.string().refine(isIsoDate, 'a real date written YYYY-MM-DD'),
    opinionType: z.enum(OPINION_TYPES),
    opinionCommitment: bytes32,
    manifestSalt: bytes32,
  })
  .refine((m) => (m.version === 1) === (m.reasonCode === 'INITIAL'), {
    message: 'version 1, and only version 1, has reasonCode INITIAL',
    path: ['reasonCode'],
  });

export type Manifest = z.infer<typeof ManifestV1>;

export class ManifestError extends Error {
  constructor(
    readonly code: 'NOT_AN_OBJECT' | 'UNKNOWN_SCHEMA_VERSION' | 'UNKNOWN_NORMALISER_VERSION' | 'INVALID',
    message: string,
  ) {
    super(message);
    this.name = 'ManifestError';
  }
}

/** Validates an untrusted value as a manifest, refusing unknown versions first. */
export function parseManifest(value: unknown): Manifest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ManifestError('NOT_AN_OBJECT', 'a manifest is a JSON object');
  }
  const { schema, norm } = value as { schema?: unknown; norm?: unknown };
  if (schema !== MANIFEST_SCHEMA_VERSION) {
    throw new ManifestError('UNKNOWN_SCHEMA_VERSION', `manifest schema ${String(schema)} is not one this reader knows`);
  }
  if (norm !== NORMALISER_VERSION) {
    throw new ManifestError('UNKNOWN_NORMALISER_VERSION', `normaliser version ${String(norm)} is not one this reader knows`);
  }
  const parsed = ManifestV1.safeParse(value);
  if (!parsed.success) {
    throw new ManifestError('INVALID', parsed.error.issues.map((i) => `${i.path.join('.') || '$'}: ${i.message}`).join('; '));
  }
  return parsed.data;
}

export function buildManifest(fields: Omit<Manifest, 'schema' | 'norm'>): Manifest {
  return parseManifest({ schema: MANIFEST_SCHEMA_VERSION, norm: NORMALISER_VERSION, ...fields });
}

export function canonicalManifest(manifest: Manifest): string {
  return strictCanonicalJson(parseManifest(manifest));
}

export function manifestHashOf(manifest: Manifest): Hex {
  return sha256(new TextEncoder().encode(canonicalManifest(manifest)));
}
