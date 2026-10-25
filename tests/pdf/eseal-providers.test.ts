import fs from 'node:fs';
import path from 'node:path';
import { p256 } from '@noble/curves/nist';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cscSigner, ecdsaDer, type CscConfig } from '@/lib/eseal/csc';
import { providerUrl } from '@/lib/eseal/http';
import { checkSeal, sealPdf } from '@/lib/eseal/pades';
import { rfc3161Timestamper } from '@/lib/eseal/tsa';
import { SealError, type SealSigner, type Timestamper } from '@/lib/eseal/types';
import { stampPdf } from '@/lib/stamp';
import type { StampFields } from '@/lib/stamp-fields';
import { startFakeSealProvider, type FakeSealProvider } from '../helpers/fake-seal-provider';
import { createTestPki, type TestPki } from '../helpers/test-pki';

/**
 * The seal's two providers over HTTP (#70): a CSC API v2 signing service and
 * an RFC 3161 timestamping authority, both played by a fake on the loopback
 * address that holds the test PKI's keys. Neither is ever sent the document.
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

let rsa: TestPki;
let ec: TestPki;
let stamped: Uint8Array;
let provider: FakeSealProvider;
let ecProvider: FakeSealProvider;

const codeOf = (promise: Promise<unknown>) =>
  promise.then(
    () => 'NO_ERROR',
    (error: unknown) => (error instanceof SealError ? error.code : String(error)),
  );
const csc = (p: FakeSealProvider, extra: Partial<CscConfig> = {}) =>
  cscSigner({ url: p.cscUrl, tokenUrl: p.tokenUrl, clientId: p.clientId, clientSecret: p.clientSecret, credentialId: p.credentialId, ...extra });
const tsa = (p: FakeSealProvider) => rfc3161Timestamper({ url: p.tsaUrl });
const seal = (signer: SealSigner, timestamper: Timestamper) => sealPdf(stamped, { signer, timestamper, signingTime: new Date(), reason: 'test' });

beforeAll(async () => {
  [rsa, ec] = await Promise.all([createTestPki(), createTestPki({ sealKey: 'ec' })]);
  stamped = await stampPdf(new Uint8Array(fs.readFileSync(path.join(import.meta.dirname, '..', 'fixtures', 'pdf', 'en-unmodified.pdf'))), FIELDS);
  [provider, ecProvider] = await Promise.all([startFakeSealProvider(rsa), startFakeSealProvider(ec)]);
}, 60_000);
afterAll(async () => {
  await Promise.all([provider?.close(), ecProvider?.close()]);
});

describe('sealing through a CSC v2 service and an RFC 3161 authority', () => {
  it('seals with a key the provider holds, and sends it digests, never the document', async () => {
    provider.requests.length = 0;
    const sealed = await seal(csc(provider), tsa(provider));
    expect((await checkSeal(sealed, [rsa.rootDer], stamped)).signer).toContain('Example Audit OOD (test seal)');
    expect(provider.requests.map((r) => r.path)).toEqual(['/oauth2/token', '/csc/v2/credentials/info', '/csc/v2/credentials/authorize', '/csc/v2/signatures/signHash', '/tsa']);
    for (const request of provider.requests) {
      expect(request.body.length).toBeLessThan(1024);
      expect(request.body.includes(Buffer.from('%PDF'))).toBe(false);
    }
    expect(provider.requests.at(-1)!.headers['content-type']).toBe('application/timestamp-query');
  });

  it('signs in with HTTP Basic at auth/login when no OAuth token endpoint is given', async () => {
    provider.requests.length = 0;
    const sealed = await seal(csc(provider, { tokenUrl: undefined }), tsa(provider));
    await checkSeal(sealed, [rsa.rootDer], stamped);
    expect(provider.requests[0].path).toBe('/csc/v2/auth/login');
  });

  it('takes an ECDSA signature as DER or as r ‖ s, and writes DER', async () => {
    for (const rawEcdsa of [false, true]) {
      ecProvider.behaviour = { authMode: 'implicit', rawEcdsa };
      const sealed = await seal(csc(ecProvider), tsa(ecProvider));
      await checkSeal(sealed, [ec.rootDer], stamped);
    }
    const signature = p256.sign(new Uint8Array(32).fill(9), p256.utils.randomPrivateKey());
    expect(Buffer.from(ecdsaDer(signature.toCompactRawBytes())).equals(Buffer.from(signature.toDERRawBytes()))).toBe(true);
  });

  it('gives an explicit credential its PIN, and refuses to wait on a person', async () => {
    provider.behaviour = { authMode: 'explicit', pin: '246810' };
    await checkSeal(await seal(csc(provider, { pin: '246810' }), tsa(provider)), [rsa.rootDer], stamped);
    expect(JSON.parse(provider.requests.findLast((r) => r.path.endsWith('/authorize'))!.body.toString()).PIN).toBe('246810');
    expect(await codeOf(seal(csc(provider), tsa(provider)))).toBe('SIGNER_REFUSED');
    provider.behaviour = { authMode: 'explicit', pin: '246810', otp: true };
    expect(await codeOf(seal(csc(provider, { pin: '246810' }), tsa(provider)))).toBe('SIGNER_REFUSED');
    provider.behaviour = { authMode: 'oauth2code' };
    expect(await codeOf(seal(csc(provider), tsa(provider)))).toBe('SIGNER_REFUSED');
    provider.behaviour = { authMode: 'implicit' };
  });

  it('waits on a provider that is down or busy, and refuses one that says no', async () => {
    provider.behaviour = { authMode: 'implicit', cscStatus: 503 };
    expect(await codeOf(seal(csc(provider), tsa(provider)))).toBe('SIGNER_UNAVAILABLE');
    provider.behaviour = { authMode: 'implicit', cscStatus: 401 };
    expect(await codeOf(seal(csc(provider), tsa(provider)))).toBe('SIGNER_REFUSED');
    const wrongSecret = cscSigner({ url: provider.cscUrl, tokenUrl: provider.tokenUrl, clientId: provider.clientId, clientSecret: 'wrong', credentialId: provider.credentialId });
    provider.behaviour = { authMode: 'implicit' };
    expect(await codeOf(seal(wrongSecret, tsa(provider)))).toBe('SIGNER_REFUSED');

    const closed = await startFakeSealProvider(rsa);
    const unreachable = rfc3161Timestamper({ url: closed.tsaUrl });
    await closed.close();
    expect(await codeOf(seal(csc(provider), unreachable))).toBe('TIMESTAMP_UNAVAILABLE');
    for (const [behaviour, code] of [
      [{ tsaHttpStatus: 502 }, 'TIMESTAMP_UNAVAILABLE'],
      [{ tsaStatus: 3 }, 'TIMESTAMP_UNAVAILABLE'],
      [{ tsaHttpStatus: 403 }, 'TIMESTAMP_REFUSED'],
      [{ tsaStatus: 2 }, 'TIMESTAMP_REFUSED'],
      [{ wrongNonce: true }, 'TIMESTAMP_REFUSED'],
    ] as const) {
      provider.behaviour = { authMode: 'implicit', ...behaviour };
      expect(await codeOf(seal(csc(provider), tsa(provider)))).toBe(code);
    }
    provider.behaviour = { authMode: 'implicit' };
  });

  it('asks the authority for a policy, and holds the token to it', async () => {
    const sealed = await seal(csc(provider), rfc3161Timestamper({ url: provider.tsaUrl, policy: '1.3.6.1.4.1.55555.2.7' }));
    await checkSeal(sealed, [rsa.rootDer], stamped);
  });

  it('reaches providers over HTTPS only, plain HTTP only to this machine, and never with credentials in the URL', () => {
    expect(providerUrl('https://csc.example/csc/v2', 'CSC_URL').hostname).toBe('csc.example');
    expect(providerUrl('http://127.0.0.1:8080/tsa', 'TSA_URL').port).toBe('8080');
    expect(() => providerUrl('http://tsa.example/', 'TSA_URL')).toThrow(/https/);
    expect(() => providerUrl('https://user:pw@tsa.example/', 'TSA_URL')).toThrow(/credentials/);
    expect(() => providerUrl('not a url', 'TSA_URL')).toThrow(/not a URL/);
    expect(() => rfc3161Timestamper({ url: 'https://tsa.example/', username: 'only-a-name' })).toThrow(/both/);
  });
});
