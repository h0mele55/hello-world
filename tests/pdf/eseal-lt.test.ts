import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument, PDFString, PDFName } from '@cantoo/pdf-lib';
import * as pkijs from 'pkijs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addValidationData, validationDataFor } from '@/lib/eseal/long-term';
import { sealStampedCopy } from '@/lib/eseal/copy';
import { checkSeal, readSeal, sealPdf } from '@/lib/eseal/pades';
import { SealError, sealMayRetry } from '@/lib/eseal/types';
import { parsePdf } from '@/lib/pdf/parse';
import { stampPdf } from '@/lib/stamp';
import type { StampFields } from '@/lib/stamp-fields';
import { dssUpdate, vriKeyOf } from '@/lib/verify-core/dss';
import { parseCertificate } from '@/lib/verify-core/pki';
import { crlStatus, ocspStatus, type ValidationData } from '@/lib/verify-core/revocation';
import { sealStatusFor } from '@/lib/verify-core/seal';
import { startFakeStatusResponder, type FakeStatusResponder } from '../helpers/fake-status-responder';
import { createTestPki, type StatusBehaviour, type TestPki } from '../helpers/test-pki';

/**
 * The long-term seal (#119, PAdES baseline B-LT): after the B-T seal, the
 * worker fetches the status of every certificate the seal relies on from the
 * OCSP responder or CRL that certificate names, checks it, and adds it with
 * the certificates in one more incremental update. A throwaway PKI with an
 * intermediate CA, and its status service on loopback, stand in for the trust
 * service provider's; pdfsig and qpdf read the result independently.
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
const HOUR = 60 * 60 * 1000;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eseal-lt-'));
const tool = (name: string) => spawnSync('which', [name]).status === 0;
const codeOf = (promise: Promise<unknown>) =>
  promise.then(
    () => 'NO_ERROR',
    (error: unknown) => (error instanceof SealError ? error.code : String(error)),
  );
const concat = (a: Uint8Array, b: Uint8Array) => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
};

let responder: FakeStatusResponder;
let stamped: Uint8Array;

/** A PKI whose certificates name the fake responder, which serves it. */
async function pkiServed(options: { intermediate?: boolean } = { intermediate: true }): Promise<TestPki> {
  const pki = await createTestPki({ statusUrls: { ocsp: responder.ocspUrl, crl: responder.crlUrl }, intermediate: options.intermediate });
  responder.serve(pki);
  return pki;
}
const sealWith = (pki: TestPki) => sealPdf(stamped, { signer: pki.signer, timestamper: pki.timestamper, signingTime: new Date(), reason: 'Distribution copy of an anchored audit report' });

beforeAll(async () => {
  responder = await startFakeStatusResponder();
  stamped = await stampPdf(fixture('en-unmodified.pdf'), FIELDS);
}, 60_000);

afterAll(async () => {
  await responder.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('a long-term seal', () => {
  let pki: TestPki;
  let sealed: Uint8Array;
  let longTerm: Uint8Array;

  beforeAll(async () => {
    pki = await pkiServed();
    sealed = await sealWith(pki);
    responder.requests.length = 0;
    longTerm = await addValidationData(sealed, [pki.rootDer]);
  }, 60_000);

  it('adds one more update after the seal, with every certificate and a good status for each but the root', async () => {
    expect(Buffer.from(longTerm.subarray(0, sealed.length)).equals(Buffer.from(sealed))).toBe(true);
    const { dss } = readSeal(longTerm);
    // The seal, the authority, the intermediate that issued both, and the root; OCSP for the two leaves, the root's CRL for the intermediate.
    expect(dss!.data.certs).toHaveLength(4);
    expect(dss!.data.ocsps).toHaveLength(2);
    expect(dss!.data.crls).toHaveLength(1);
    expect(responder.requests).toEqual([
      { method: 'POST', path: '/ocsp' },
      { method: 'GET', path: '/crl/root.crl' },
      { method: 'POST', path: '/ocsp' },
    ]);
    expect(await checkSeal(longTerm, [pki.rootDer], stamped)).toMatchObject({ longTerm: true });
    expect(await checkSeal(sealed, [pki.rootDer], stamped)).toMatchObject({ longTerm: false });
  });

  it('changes nothing a reader sees: the same pages, text and stamp', async () => {
    const [before, after] = await Promise.all([parsePdf(sealed), parsePdf(longTerm)]);
    if (!before.ok || !after.ok) throw new Error('a file did not parse');
    expect(after.pdf.pages).toEqual(before.pdf.pages);
    expect(after.pdf.flags).toEqual(before.pdf.flags);
    expect(after.pdf.info).toEqual(before.pdf.info);
  });

  it('every verifier reports it as long-term, and a B-T copy as not', async () => {
    expect(await sealStatusFor(longTerm, [pki.rootDer])).toMatchObject({ status: 'SEALED', longTerm: true });
    expect(await sealStatusFor(sealed, [pki.rootDer])).toMatchObject({ status: 'SEALED', longTerm: false });
  });

  it('is written the same way every time, and never twice', async () => {
    const data = readSeal(longTerm).dss!.data;
    const key = await vriKeyOf(readSeal(sealed).contents);
    expect(Buffer.from(dssUpdate(sealed, data, key)).equals(Buffer.from(longTerm.subarray(sealed.length)))).toBe(true);
    expect(() => dssUpdate(longTerm, data, key)).toThrow(SealError);
    expect(await codeOf(addValidationData(longTerm, [pki.rootDer]))).toBe('PDF_REFUSED');
  });

  it.runIf(tool('pdfsig') || process.env.CI)('pdfsig still finds the signature valid', () => {
    fs.writeFileSync(path.join(dir, 'long-term.pdf'), longTerm);
    const out = execFileSync('pdfsig', ['-nocert', path.join(dir, 'long-term.pdf')], { encoding: 'utf8' });
    expect(out).toContain('Signature Type: ETSI.CAdES.detached');
    expect(out).toContain('Signature Validation: Signature is Valid.');
  });

  it.runIf(tool('qpdf'))('qpdf finds the file sound, and the DSS where the catalog says', () => {
    fs.writeFileSync(path.join(dir, 'long-term.pdf'), longTerm);
    const check = spawnSync('qpdf', ['--check', path.join(dir, 'long-term.pdf')], { encoding: 'utf8' });
    expect(check.stdout).toContain('No syntax or stream encoding errors found');
    expect(check.status).toBe(0);
    const json = JSON.parse(execFileSync('qpdf', ['--json=1', '--json-key=objects', path.join(dir, 'long-term.pdf')], { encoding: 'utf8' })) as { objects: Record<string, { '/Type'?: string; '/Certs'?: string[]; '/VRI'?: Record<string, unknown> }> };
    const dssObject = Object.values(json.objects).find((o) => o && o['/Type'] === '/DSS');
    expect(dssObject?.['/Certs']).toHaveLength(4);
    expect(Object.keys(dssObject?.['/VRI'] ?? {})).toHaveLength(1);
  });
});

describe('fetching the statuses', () => {
  it('uses a certificate’s CRL when its OCSP responder’s answer does not hold', async () => {
    const pki = await pkiServed();
    pki.status.behaviour = { responder: 'stranger' };
    const data = await validationDataFor(await sealWith(pki), [pki.rootDer]);
    expect(data.ocsps).toHaveLength(0);
    expect(data.crls).toHaveLength(2);
  }, 60_000);

  it('waits when no status source answers, and the worker tries again later', async () => {
    const pki = await pkiServed();
    const sealed = await sealWith(pki);
    responder.httpStatus = 503;
    try {
      const code = await codeOf(addValidationData(sealed, [pki.rootDer]));
      expect(code).toBe('REVOCATION_UNAVAILABLE');
      expect(sealMayRetry(code as 'REVOCATION_UNAVAILABLE')).toBe(true);
    } finally {
      responder.httpStatus = null;
    }
  }, 60_000);

  it('stops at a revoked certificate, wherever its status is read', async () => {
    const pki = await pkiServed();
    const sealed = await sealWith(pki);
    pki.status.revoke('seal');
    expect(await codeOf(addValidationData(sealed, [pki.rootDer]))).toBe('CERTIFICATE_REVOKED');
    pki.status.behaviour = { responder: 'stranger' };
    expect(await codeOf(addValidationData(sealed, [pki.rootDer]))).toBe('CERTIFICATE_REVOKED');
  }, 60_000);

  it('refuses a certificate that names no status source', async () => {
    const pki = await createTestPki();
    const sealed = await sealWith(pki);
    expect(await codeOf(addValidationData(sealed, [pki.rootDer]))).toBe('NO_REVOCATION_SOURCE');
  }, 60_000);

  it('through the worker’s copy seal: B-LT is checked as a whole, B-T is unchanged', async () => {
    const pki = await pkiServed();
    const base = { signer: pki.signer, timestamper: pki.timestamper, trustAnchors: [pki.rootDer] };
    const lt = await sealStampedCopy(stamped, { ...base, level: 'B-LT' }, new Date());
    expect(lt.check.longTerm).toBe(true);
    const bt = await sealStampedCopy(stamped, base, new Date());
    expect(bt.check.longTerm).toBe(false);
    expect(readSeal(bt.sealed).dss).toBeNull();
  }, 60_000);
});

describe('a status that does not hold is refused, by name', () => {
  let pki: TestPki;
  let seal: pkijs.Certificate;
  let tsa: pkijs.Certificate;
  let issuer: pkijs.Certificate;
  let root: pkijs.Certificate;
  let request: Uint8Array;
  const at = () => new Date();

  beforeAll(async () => {
    pki = await createTestPki({ statusUrls: { ocsp: 'http://127.0.0.1:9/ocsp', crl: 'http://127.0.0.1:9/crl' }, intermediate: true });
    [seal, issuer, root] = pki.sealChain.map(parseCertificate);
    tsa = parseCertificate(pki.tsaDer);
    const ocspRequest = new pkijs.OCSPRequest();
    await ocspRequest.createForCertificate(seal, { hashAlgorithm: 'SHA-1', issuerCertificate: issuer });
    request = new Uint8Array(ocspRequest.toSchema(true).toBER(false));
  }, 60_000);

  const ocsp = async (behaviour: StatusBehaviour, when = at()) => {
    pki.status.behaviour = behaviour;
    return codeOf(ocspStatus(await pki.status.ocsp(request), seal, issuer, when, new Date()));
  };
  const crl = async (behaviour: StatusBehaviour, cert = seal, of = 'intermediate') => {
    pki.status.behaviour = behaviour;
    return codeOf(crlStatus((await pki.status.crl(of))!, cert, cert === seal ? issuer : root, at(), new Date()));
  };

  it('an OCSP response from the issuer or a delegate that needs no status is good', async () => {
    expect(await ocsp({})).toBe('NO_ERROR');
    expect(await ocsp({ responder: 'delegated' })).toBe('NO_ERROR');
    expect(await ocsp({ nextUpdate: null, thisUpdate: new Date(Date.now() - HOUR) })).toBe('NO_ERROR');
  });

  it('an OCSP response that does not hold is REVOCATION_REFUSED', async () => {
    expect(await ocsp({ responder: 'stranger' })).toBe('REVOCATION_REFUSED');
    expect(await ocsp({ responder: 'delegated-without-nocheck' })).toBe('REVOCATION_REFUSED');
    expect(await ocsp({ certStatus: 'unknown' })).toBe('REVOCATION_REFUSED');
    expect(await ocsp({ responseStatus: 2 })).toBe('REVOCATION_REFUSED');
    // Not current at the seal's time: its nextUpdate is before it, or with none it is over a day older; or it is dated in the future.
    expect(await ocsp({ thisUpdate: new Date(Date.now() - 3 * HOUR), nextUpdate: new Date(Date.now() - 2 * HOUR) })).toBe('REVOCATION_REFUSED');
    expect(await ocsp({ thisUpdate: new Date(Date.now() - 48 * HOUR), nextUpdate: null })).toBe('REVOCATION_REFUSED');
    expect(await ocsp({ thisUpdate: new Date(Date.now() + HOUR) })).toBe('REVOCATION_REFUSED');
    pki.status.behaviour = {};
    // A successful status with no response in it; and bytes that are not DER at all.
    expect(await codeOf(ocspStatus(new Uint8Array([0x30, 0x03, 0x0a, 0x01, 0x00]), seal, issuer, at(), new Date()))).toBe('REVOCATION_REFUSED');
    expect(await codeOf(ocspStatus(new Uint8Array([0x01, 0x02]), seal, issuer, at(), new Date()))).toBe('MALFORMED');
  });

  it('an OCSP response about another certificate says nothing about this one', async () => {
    pki.status.behaviour = {};
    expect(await ocspStatus(await pki.status.ocsp(request), tsa, issuer, at(), new Date())).toBeNull();
  });

  it('a CRL is good only from the issuer, current, and not listing the certificate', async () => {
    expect(await crl({})).toBe('NO_ERROR');
    expect(await crl({ crlSigner: 'stranger' })).toBe('REVOCATION_REFUSED');
    expect(await crl({ thisUpdate: new Date(Date.now() - 3 * HOUR), nextUpdate: new Date(Date.now() - 2 * HOUR) })).toBe('REVOCATION_REFUSED');
    pki.status.behaviour = {};
    // The root's CRL is not the intermediate-issued seal's issuer's.
    expect(await crlStatus((await pki.status.crl('root'))!, seal, issuer, at(), new Date())).toBeNull();
  });

  it('a revoked certificate is CERTIFICATE_REVOKED, by OCSP and by CRL', async () => {
    const revoked = await createTestPki({ statusUrls: { ocsp: 'http://127.0.0.1:9/ocsp', crl: 'http://127.0.0.1:9/crl' }, intermediate: true });
    const [leaf, ca] = revoked.sealChain.map(parseCertificate);
    const ocspRequest = new pkijs.OCSPRequest();
    await ocspRequest.createForCertificate(leaf, { hashAlgorithm: 'SHA-1', issuerCertificate: ca });
    revoked.status.revoke('seal');
    expect(await codeOf(ocspStatus(await revoked.status.ocsp(new Uint8Array(ocspRequest.toSchema(true).toBER(false))), leaf, ca, at(), new Date()))).toBe('CERTIFICATE_REVOKED');
    expect(await codeOf(crlStatus((await revoked.status.crl('intermediate'))!, leaf, ca, at(), new Date()))).toBe('CERTIFICATE_REVOKED');
  }, 60_000);
});

describe('what follows a seal must be exactly its validation data', () => {
  let pki: TestPki;
  let sealed: Uint8Array;
  let longTerm: Uint8Array;
  let data: ValidationData;
  let key: string;

  beforeAll(async () => {
    pki = await pkiServed();
    sealed = await sealWith(pki);
    longTerm = await addValidationData(sealed, [pki.rootDer]);
    data = readSeal(longTerm).dss!.data;
    key = await vriKeyOf(readSeal(sealed).contents);
  }, 60_000);

  const check = (bytes: Uint8Array) => codeOf(checkSeal(bytes, [pki.rootDer]));

  it('refuses another update after it, however small', async () => {
    const doc = await PDFDocument.load(longTerm, { forIncrementalUpdate: true, updateMetadata: false });
    doc.catalog.set(PDFName.of('Lang'), PDFString.of('bg'));
    expect(await check(new Uint8Array(await doc.commit()))).toBe('NOT_WHOLE_FILE');
    expect(await check(concat(longTerm, new TextEncoder().encode('%one more line\n')))).toBe('NOT_WHOLE_FILE');
  });

  it('refuses an update that changes the catalog beyond its /DSS', async () => {
    const tail = Buffer.from(longTerm.subarray(sealed.length)).toString('latin1');
    const edited = tail.replace(/\/DSS (\d+) 0 R\n>>/, '/OpenAction 7 0 R\n/DSS $1 0 R\n>>');
    expect(edited).not.toBe(tail);
    expect(await check(concat(sealed, Buffer.from(edited, 'latin1')))).toBe('NOT_WHOLE_FILE');
  });

  it('refuses validation data filed under another signature', async () => {
    expect(await check(concat(sealed, dssUpdate(sealed, data, 'A'.repeat(40))))).toBe('NOT_WHOLE_FILE');
  });

  it('checks the statuses a well-formed update carries: none missing, none that does not hold', async () => {
    const without = { ...data, ocsps: data.ocsps.slice(0, 1) };
    expect(await check(concat(sealed, dssUpdate(sealed, without, key)))).toBe('REVOCATION_REFUSED');
    const junk = { ...data, crls: [new Uint8Array([0x30, 0x00])] };
    expect(await check(concat(sealed, dssUpdate(sealed, junk, key)))).toBe('MALFORMED');
    pki.status.revoke('tsa');
    const tsaRequest = new pkijs.OCSPRequest();
    await tsaRequest.createForCertificate(parseCertificate(pki.tsaDer), { hashAlgorithm: 'SHA-1', issuerCertificate: parseCertificate(pki.intermediateDer!) });
    const revoked = { ...data, ocsps: [data.ocsps[0], await pki.status.ocsp(new Uint8Array(tsaRequest.toSchema(true).toBER(false)))] };
    expect(await check(concat(sealed, dssUpdate(sealed, revoked, key)))).toBe('CERTIFICATE_REVOKED');
    expect(await sealStatusFor(concat(sealed, dssUpdate(sealed, revoked, key)), [pki.rootDer])).toEqual({ status: 'INVALID', reason: 'CERTIFICATE_REVOKED' });
  });
});
