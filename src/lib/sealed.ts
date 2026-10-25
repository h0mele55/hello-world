import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM sealing for confidential data at rest: uploaded PDFs, the
 * extracted and confirmed opinion, the manifest.
 *
 * Every seal names what it protects in its additional authenticated data
 * (`context`, e.g. "report-version:<id>:confirmedOpinion"), so a ciphertext
 * copied into another row or field fails to open instead of being read as that
 * row's data. A fresh 12-byte IV per seal; never reused under one key.
 *
 * Envelope (bytes): 0x01 | keyVersion (u16 BE) | iv (12) | tag (16) | ciphertext
 */
const ENVELOPE_V1 = 0x01;

/** Bytes backed by a plain ArrayBuffer: what Prisma stores in a Bytes column. */
export type Bytes = Uint8Array<ArrayBuffer>;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 1 + 2 + IV_BYTES + TAG_BYTES;

export interface SealingKey {
  key: Uint8Array;
  version: number;
}

export class SealError extends Error {
  constructor(readonly code: 'KEY_INVALID' | 'ENVELOPE_INVALID' | 'KEY_VERSION_UNKNOWN' | 'AUTH_FAILED') {
    super(`Cannot open sealed data: ${code}`);
    this.name = 'SealError';
  }
}

function assertKey({ key, version }: SealingKey) {
  if (key.length !== 32 || !Number.isInteger(version) || version < 1 || version > 0xffff) throw new SealError('KEY_INVALID');
}

export interface Sealed {
  iv: Bytes;
  authTag: Bytes;
  ciphertext: Bytes;
}

/** Encrypts with a fresh IV; returns the parts, for callers that store them apart (files). */
export function encrypt(sealingKey: SealingKey, plaintext: Uint8Array, context: string): Sealed {
  assertKey(sealingKey);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', sealingKey.key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(context, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv: new Uint8Array(iv), authTag: new Uint8Array(cipher.getAuthTag()), ciphertext: new Uint8Array(ciphertext) };
}

export function decrypt(key: Uint8Array, sealed: { iv: Uint8Array; authTag: Uint8Array; ciphertext: Uint8Array }, context: string): Bytes {
  if (key.length !== 32) throw new SealError('KEY_INVALID');
  if (sealed.iv.length !== IV_BYTES || sealed.authTag.length !== TAG_BYTES) throw new SealError('ENVELOPE_INVALID');
  const decipher = createDecipheriv('aes-256-gcm', key, sealed.iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(Buffer.from(context, 'utf8'));
  decipher.setAuthTag(sealed.authTag);
  try {
    return new Uint8Array(Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]));
  } catch {
    throw new SealError('AUTH_FAILED');
  }
}

/** Seals into one self-describing envelope, for a database column. */
export function seal(sealingKey: SealingKey, plaintext: Uint8Array, context: string): Bytes {
  const { iv, authTag, ciphertext } = encrypt(sealingKey, plaintext, context);
  const header = Buffer.alloc(3);
  header[0] = ENVELOPE_V1;
  header.writeUInt16BE(sealingKey.version, 1);
  return new Uint8Array(Buffer.concat([header, iv, authTag, ciphertext]));
}

/** Opens an envelope with whichever known key its version names. */
export function open(keys: readonly SealingKey[], envelope: Uint8Array, context: string): Bytes {
  if (envelope.length < HEADER_BYTES || envelope[0] !== ENVELOPE_V1) throw new SealError('ENVELOPE_INVALID');
  const version = Buffer.from(envelope).readUInt16BE(1);
  const match = keys.find((k) => k.version === version);
  if (!match) throw new SealError('KEY_VERSION_UNKNOWN');
  return decrypt(
    match.key,
    { iv: envelope.subarray(3, 3 + IV_BYTES), authTag: envelope.subarray(3 + IV_BYTES, HEADER_BYTES), ciphertext: envelope.subarray(HEADER_BYTES) },
    context,
  );
}

export function sealJson(sealingKey: SealingKey, value: unknown, context: string): Bytes {
  return seal(sealingKey, new TextEncoder().encode(JSON.stringify(value)), context);
}

export function openJson<T = unknown>(keys: readonly SealingKey[], envelope: Uint8Array, context: string): T {
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(open(keys, envelope, context))) as T;
}
