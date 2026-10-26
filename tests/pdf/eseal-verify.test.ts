import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { sealPdf } from '@/lib/eseal/pades';
import { stampPdf } from '@/lib/stamp';
import type { StampFields } from '@/lib/stamp-fields';
import { certificatesFromPem, sealStatusFor } from '@/lib/verify-core/seal';
import { createTestPki, pemOf, type TestPki } from '../helpers/test-pki';

/**
 * What a verifier shows about a matched copy's seal (#120): the shared check,
 * as the browser and the CLI run it, against the roots the firm publishes. It
 * never decides a verdict, so every outcome is a status, never an error.
 */

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

let pki: TestPki;
let stamped: Uint8Array;
let sealed: Uint8Array;

beforeAll(async () => {
  pki = await createTestPki();
  stamped = await stampPdf(new Uint8Array(fs.readFileSync(path.join(import.meta.dirname, '..', 'fixtures', 'pdf', 'en-unmodified.pdf'))), FIELDS);
  sealed = await sealPdf(stamped, { signer: pki.signer, timestamper: pki.timestamper, signingTime: new Date(), reason: 'test' });
}, 60_000);

describe('a matched copy’s seal, as the verifiers show it', () => {
  it('is SEALED, with its signer and time, against the firm’s roots', async () => {
    const status = await sealStatusFor(sealed, [pki.rootDer]);
    expect(status).toMatchObject({ status: 'SEALED', signer: expect.stringContaining('Example Audit OOD (test seal)') });
    expect(status.status === 'SEALED' && Math.abs(status.sealedAt - Date.now() / 1000)).toBeLessThan(60);
  });

  it('is NOT_SEALED for a copy with no signature, and NO_ROOTS when the verifier has no roots', async () => {
    expect(await sealStatusFor(stamped, [pki.rootDer])).toEqual({ status: 'NOT_SEALED' });
    expect(await sealStatusFor(sealed, [])).toEqual({ status: 'NO_ROOTS' });
  });

  it('is INVALID, with the reason, for a changed file, bytes added after it, or roots that do not vouch for it', async () => {
    const flipped = sealed.slice();
    flipped[300] ^= 1;
    expect(await sealStatusFor(flipped, [pki.rootDer])).toEqual({ status: 'INVALID', reason: 'DIGEST_MISMATCH' });
    expect(await sealStatusFor(new Uint8Array([...sealed, 0x0a]), [pki.rootDer])).toEqual({ status: 'INVALID', reason: 'NOT_WHOLE_FILE' });
    const other = await createTestPki();
    expect(await sealStatusFor(sealed, [other.rootDer])).toEqual({ status: 'INVALID', reason: 'UNTRUSTED' });
  });

  it('reads the published roots from PEM, and refuses a block that is not a certificate', () => {
    expect(certificatesFromPem(pemOf(pki.rootDer) + pemOf(pki.tsaDer)).map((der) => Buffer.from(der).toString('hex'))).toEqual([
      Buffer.from(pki.rootDer).toString('hex'),
      Buffer.from(pki.tsaDer).toString('hex'),
    ]);
    expect(certificatesFromPem('no certificates here')).toEqual([]);
    expect(() => certificatesFromPem('-----BEGIN CERTIFICATE-----\nMAA=\n-----END CERTIFICATE-----')).toThrow();
  });
});
