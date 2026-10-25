import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { sha256 } from '@/lib/commitments';
import { parsePdf } from '@/lib/pdf/parse';
import { checkSeal, readSeal, sealPdf } from '@/lib/eseal/pades';
import { readTimestampToken } from '@/lib/eseal/cms';
import { SealError, type SealSigner, type Timestamper } from '@/lib/eseal/types';
import { stampPdf } from '@/lib/stamp';
import type { StampFields } from '@/lib/stamp-fields';
import { createTestPki, pemOf, type TestPki } from '../helpers/test-pki';

/**
 * The seal on a distribution copy (#70): a PAdES B-T signature with an RFC
 * 3161 timestamp, added to the stamped copy as one more incremental update.
 * A throwaway PKI stands in for the qualified trust service provider and the
 * timestamping authority; Poppler's pdfsig and OpenSSL check the result
 * independently of this code.
 */

const fixture = (name: string) => new Uint8Array(fs.readFileSync(path.join(import.meta.dirname, '..', 'fixtures', 'pdf', name)));
const FIELDS: StampFields = {
  stamp: 1,
  chainId: 11155111,
  contract: '0x87Ba96d1d48e280429A8ead1059334C34507c31F',
  recordId: `0x${'1a'.repeat(32)}`,
  txHash: `0x${'2b'.repeat(32)}`,
  blockNumber: 9876543,
  familyId: `0x${'3c'.repeat(32)}`,
  version: 1,
  verifyUrl: 'https://anchor.example/verify',
  opinionType: 'UNMODIFIED',
  opinionSalt: `0x${'4d'.repeat(32)}`,
  norm: 1,
};
const SIGNED_AT = new Date('2026-10-25T12:00:00Z');

let pki: TestPki;
let stamped: Uint8Array;
let sealed: Uint8Array;

const codeOf = (promise: Promise<unknown>) =>
  promise.then(
    () => 'NO_ERROR',
    (error: unknown) => (error instanceof SealError ? error.code : String(error)),
  );
const seal = (bytes: Uint8Array, with_: { signer?: SealSigner; timestamper?: Timestamper } = {}) =>
  sealPdf(bytes, { signer: with_.signer ?? pki.signer, timestamper: with_.timestamper ?? pki.timestamper, signingTime: SIGNED_AT, reason: 'Distribution copy of an anchored audit report' });
const tool = (name: string) => spawnSync('which', [name]).status === 0;

beforeAll(async () => {
  pki = await createTestPki();
  stamped = await stampPdf(fixture('en-unmodified.pdf'), FIELDS);
  sealed = await seal(stamped);
}, 60_000);

describe('sealing a stamped copy', () => {
  it('adds one incremental update: the stamped file is the sealed file’s prefix, and its pages and text are untouched', async () => {
    expect(Buffer.from(sealed.subarray(0, stamped.length)).equals(Buffer.from(stamped))).toBe(true);
    const [before, after] = await Promise.all([parsePdf(stamped), parsePdf(sealed)]);
    if (!before.ok || !after.ok) throw new Error('a fixture did not parse');
    expect(after.pdf.pages).toEqual(before.pdf.pages);
    expect(after.pdf.flags).toEqual({ ...before.pdf.flags, signed: true });
    // The anchor stamp still reads from the sealed file.
    expect(after.pdf.info).toMatchObject({ [Object.keys(before.pdf.info).find((k) => k.startsWith('Custom:'))!]: expect.any(String) });
  });

  it('passes its own check: the seal certificate, its chain, and the timestamp over the signature', async () => {
    const check = await checkSeal(sealed, [pki.rootDer], stamped);
    expect(check.signer).toContain('Example Audit OOD (test seal)');
    expect(Math.abs(check.sealedAt.getTime() - Date.now())).toBeLessThan(60_000);
    // The timestamping authority was handed one digest, of the signature, never the document's.
    const { cms, content } = readSeal(sealed);
    expect(pki.timestamper.calls).toHaveLength(1);
    expect(pki.timestamper.calls[0]).toHaveLength(32);
    expect(Buffer.from(pki.timestamper.calls[0]).equals(Buffer.from(sha256Bytes(content)))).toBe(false);
    // It comes back as the token's imprint, inside the signature.
    expect(Buffer.from(cms).includes(Buffer.from(pki.timestamper.calls[0]))).toBe(true);
  });

  it('covers the whole file but the signature itself', () => {
    const { byteRange } = readSeal(sealed);
    expect(byteRange[0]).toBe(0);
    expect(byteRange[2] + byteRange[3]).toBe(sealed.length);
    expect(byteRange[1]).toBeGreaterThan(stamped.length);
  });

  it('is refused when any byte is changed, cut or added, or when the anchors are not the issuer’s', async () => {
    const flipped = sealed.slice();
    flipped[200] ^= 1;
    expect(await codeOf(checkSeal(flipped, [pki.rootDer]))).toBe('DIGEST_MISMATCH');

    const { byteRange } = readSeal(sealed);
    const badSignature = sealed.slice();
    // A hex digit in the signature value, near the end of the CMS: the signature no longer verifies.
    const cmsEnd = byteRange[1] + 1 + readSeal(sealed).cms.length * 2;
    badSignature[cmsEnd - 40] = badSignature[cmsEnd - 40] === 0x30 ? 0x31 : 0x30;
    expect(['BAD_SIGNATURE', 'BAD_TIMESTAMP', 'MALFORMED']).toContain(await codeOf(checkSeal(badSignature, [pki.rootDer])));

    expect(await codeOf(checkSeal(new Uint8Array([...sealed, 0x0a]), [pki.rootDer]))).toBe('NOT_WHOLE_FILE');
    expect(await codeOf(checkSeal(stamped, [pki.rootDer]))).toBe('NO_SEAL');
    expect(await codeOf(checkSeal(sealed, [pki.rootDer], fixture('en-qualified.pdf')))).toBe('NOT_WHOLE_FILE');

    const other = await createTestPki();
    expect(await codeOf(checkSeal(sealed, [other.rootDer]))).toBe('UNTRUSTED');
  });

  it('refuses to seal twice, and refuses a provider whose signature or timestamp is not what was asked', async () => {
    expect(await codeOf(seal(sealed))).toBe('PDF_REFUSED');
    // A signature by another key than the certificate's is refused before any timestamp is asked for.
    const other = await createTestPki();
    const calls = pki.timestamper.calls.length;
    const wrongKey = { certificates: pki.signer.certificates, signDigest: other.signer.signDigest };
    expect(await codeOf(seal(stamped, { signer: wrongKey }))).toBe('SIGNER_REFUSED');
    expect(await codeOf(seal(stamped, { signer: { ...pki.signer, signDigest: async () => new Uint8Array(0) } }))).toBe('SIGNER_REFUSED');
    expect(pki.timestamper.calls).toHaveLength(calls);
    const wrongTimestamp = { timestamp: (digest: Uint8Array) => pki.timestamper.timestamp(sha256Bytes(new Uint8Array([...digest, 1]))) };
    expect(await codeOf(seal(stamped, { timestamper: wrongTimestamp }))).toBe('TIMESTAMP_REFUSED');
  });

  it('seals with an ECDSA P-256 key as well as with RSA', async () => {
    const ec = await createTestPki({ sealKey: 'ec' });
    const copy = await seal(stamped, ec);
    expect((await checkSeal(copy, [ec.rootDer], stamped)).signer).toContain('Example Audit OOD (test seal)');
    const { cms } = readSeal(copy);
    // ecdsa-with-SHA256, as the signature algorithm in the signer info.
    expect(Buffer.from(cms).includes(Buffer.from('06082a8648ce3d040302', 'hex'))).toBe(true);
  });

  it('refuses a seal certificate that had expired when the timestamp says it signed', async () => {
    const expired = await createTestPki({ sealNotAfter: new Date(Date.now() - 60 * 60 * 1000) });
    const copy = await seal(stamped, expired);
    expect(await codeOf(checkSeal(copy, [expired.rootDer]))).toBe('UNTRUSTED');
  });

  it('refuses a timestamp signed by anyone but a timestamping authority, even one that carries its certificate', async () => {
    const forged = await createTestPki({ forgedTimestamps: true });
    const copy = await seal(stamped, forged);
    expect(await codeOf(checkSeal(copy, [forged.rootDer]))).toBe('BAD_TIMESTAMP');
  });

  it('is a different file each time, so the copy is made once and kept', async () => {
    const again = await seal(stamped);
    expect(sha256(again)).not.toBe(sha256(sealed));
    expect((await readTimestampToken(new Uint8Array(0)).catch((e: unknown) => e)) instanceof SealError).toBe(true);
  });
});

describe('the seal, checked by other tools', () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seal-'));
    fs.writeFileSync(path.join(dir, 'sealed.pdf'), sealed);
    fs.writeFileSync(path.join(dir, 'root.pem'), pemOf(pki.rootDer));
    const { cms, content } = readSeal(sealed);
    fs.writeFileSync(path.join(dir, 'seal.p7s'), cms);
    fs.writeFileSync(path.join(dir, 'content.bin'), content);
  });

  it.runIf(tool('pdfsig') || process.env.CI)('pdfsig reads one ETSI.CAdES.detached signature over the whole file, and finds it valid', () => {
    const out = execFileSync('pdfsig', ['-nocert', path.join(dir, 'sealed.pdf')], { encoding: 'utf8' });
    expect(out).toContain('Signature Type: ETSI.CAdES.detached');
    expect(out).toContain('Signature Validation: Signature is Valid.');
    expect(out).toContain('Total document signed');
    expect(out).toMatch(/Signer Certificate Common Name: Example Audit OOD \(test seal\)/);
  });

  it.runIf(tool('openssl'))('openssl verifies the CMS signature and its chain to the root, over the byte ranges', () => {
    const run = spawnSync('openssl', ['cms', '-verify', '-binary', '-inform', 'DER', '-in', path.join(dir, 'seal.p7s'), '-content', path.join(dir, 'content.bin'), '-CAfile', path.join(dir, 'root.pem'), '-purpose', 'any', '-out', os.devNull], { encoding: 'utf8' });
    expect(run.stderr).toContain('Verification successful');
    expect(run.status).toBe(0);
    // Changing one byte of the content fails it.
    const content = fs.readFileSync(path.join(dir, 'content.bin'));
    content[100] ^= 1;
    fs.writeFileSync(path.join(dir, 'tampered.bin'), content);
    const tampered = spawnSync('openssl', ['cms', '-verify', '-binary', '-inform', 'DER', '-in', path.join(dir, 'seal.p7s'), '-content', path.join(dir, 'tampered.bin'), '-CAfile', path.join(dir, 'root.pem'), '-purpose', 'any', '-out', os.devNull], { encoding: 'utf8' });
    expect(tampered.status).not.toBe(0);
  });
});

function sha256Bytes(bytes: Uint8Array) {
  return Uint8Array.from(Buffer.from(sha256(bytes).slice(2), 'hex'));
}
