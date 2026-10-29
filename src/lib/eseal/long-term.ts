import * as pkijs from 'pkijs';
import { dssUpdate, vriKeyOf } from '../verify-core/dss';
import { parseCertificate, sameBytes } from '../verify-core/pki';
import { chainToAnchor, crlStatus, derOf, ocspStatus, revocationSources, subjectOf, type ValidationData } from '../verify-core/revocation';
import { checkDetached, readSeal } from '../verify-core/seal';
import { post } from './http';
import { SealError } from './types';

/**
 * Making a sealed copy long-term (#119, PAdES baseline B-LT): fetch the status
 * of every certificate the seal relies on, from the OCSP responder or CRL that
 * certificate names, check each with the same code every verifier uses, and
 * add them with the certificates in one more incremental update
 * (src/lib/verify-core/dss.ts). The copy can then still be checked once its
 * certificates expire or their CA's services go away.
 *
 * The URLs come only from certificates that have just been held to the firm's
 * roots, so the CA, not the file, says where the worker connects. They may be
 * plain http, as OCSP and CRLs usually are: what they answer is signed, and is
 * checked before it is kept. No redirect is followed. A responder that does not
 * answer, or answers 429 or 5xx, is REVOCATION_UNAVAILABLE and the copy waits
 * for the next pass; a revoked certificate is CERTIFICATE_REVOKED; anything
 * else that does not check is REVOCATION_REFUSED; a certificate that names
 * no source is NO_REVOCATION_SOURCE.
 */

export interface LongTermOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** The clock a status is held against for "not dated in the future". */
  now?: () => Date;
}

const OCSP_MAX_BYTES = 64 * 1024;
const CRL_MAX_BYTES = 10 * 1024 * 1024;

/** A status URL a certificate names: http or https, with no credentials. */
function statusUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SealError('REVOCATION_REFUSED', 'a certificate names a status URL that is not one');
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) throw new SealError('REVOCATION_REFUSED', `a certificate names a status URL the worker does not use: ${url.protocol}`);
  return url;
}

async function fetchOcsp(url: string, cert: pkijs.Certificate, issuer: pkijs.Certificate, options: LongTermOptions): Promise<Uint8Array> {
  const request = new pkijs.OCSPRequest();
  // SHA-1 CertIDs are what every responder answers (RFC 5019); the hash only names the certificate.
  await request.createForCertificate(cert, { hashAlgorithm: 'SHA-1', issuerCertificate: issuer });
  const answer = await post({
    url: statusUrl(url),
    body: new Uint8Array(request.toSchema(true).toBER(false)),
    headers: { 'Content-Type': 'application/ocsp-request', Accept: 'application/ocsp-response' },
    side: 'REVOCATION',
    timeoutMs: options.timeoutMs ?? 15_000,
    maxBytes: OCSP_MAX_BYTES,
    fetch: options.fetch ?? fetch,
  });
  if (answer.status !== 200) throw new SealError('REVOCATION_REFUSED', `${new URL(url).origin} answered ${answer.status}`);
  return answer.body;
}

async function fetchCrl(url: string, options: LongTermOptions): Promise<Uint8Array> {
  const answer = await post({
    url: statusUrl(url),
    method: 'GET',
    headers: { Accept: 'application/pkix-crl' },
    side: 'REVOCATION',
    timeoutMs: options.timeoutMs ?? 30_000,
    maxBytes: CRL_MAX_BYTES,
    fetch: options.fetch ?? fetch,
  });
  if (answer.status !== 200) throw new SealError('REVOCATION_REFUSED', `${new URL(url).origin} answered ${answer.status}`);
  return answer.body;
}

/**
 * One certificate's status at `at`: its OCSP responders first, then its CRLs.
 * Revoked stops at once; otherwise the first good status is kept, and with
 * none, every source not answering is UNAVAILABLE and anything else REFUSED.
 */
async function fetchStatus(cert: pkijs.Certificate, issuer: pkijs.Certificate, at: Date, options: LongTermOptions): Promise<{ ocsp?: Uint8Array; crl?: Uint8Array }> {
  const sources = revocationSources(cert);
  if (sources.ocsp.length === 0 && sources.crl.length === 0) throw new SealError('NO_REVOCATION_SOURCE', `${subjectOf(cert)} names no OCSP responder and no CRL`);
  const now = () => options.now?.() ?? new Date();
  const failures: SealError[] = [];
  const attempts = [
    ...sources.ocsp.map((url) => async () => {
      const der = await fetchOcsp(url, cert, issuer, options);
      if ((await ocspStatus(der, cert, issuer, at, now())) !== 'GOOD') throw new SealError('REVOCATION_REFUSED', `${new URL(url).origin} answered about another certificate`);
      return { ocsp: der };
    }),
    ...sources.crl.map((url) => async () => {
      const der = await fetchCrl(url, options);
      if ((await crlStatus(der, cert, issuer, at, now())) !== 'GOOD') throw new SealError('REVOCATION_REFUSED', `the CRL at ${new URL(url).origin} is not the issuer’s`);
      return { crl: der };
    }),
  ];
  for (const attempt of attempts) {
    try {
      return await attempt();
    } catch (error) {
      if (!(error instanceof SealError) || error.code === 'CERTIFICATE_REVOKED') throw error;
      failures.push(error);
    }
  }
  if (failures.every((f) => f.code === 'REVOCATION_UNAVAILABLE')) throw new SealError('REVOCATION_UNAVAILABLE', `no status source for ${subjectOf(cert)} answered`);
  throw failures.find((f) => f.code !== 'REVOCATION_UNAVAILABLE')!;
}

const addUnique = (list: Uint8Array[], der: Uint8Array) => {
  if (!list.some((known) => sameBytes(known, der))) list.push(der);
};

/** The validation data for a sealed (B-T) file: every certificate the seal relies on, and each one's status but the anchors'. */
export async function validationDataFor(sealed: Uint8Array, trustAnchors: readonly Uint8Array[], options: LongTermOptions = {}): Promise<ValidationData> {
  const seal = readSeal(sealed);
  if (seal.dss) throw new SealError('PDF_REFUSED', 'the file already carries validation data');
  const checked = await checkDetached(seal.cms, seal.content, trustAnchors);
  const anchors = trustAnchors.map(parseCertificate);
  const pool = [...checked.certificates, ...checked.stamperCertificates];
  const data: ValidationData = { certs: [], ocsps: [], crls: [] };
  const done: Uint8Array[] = [];
  for (const leaf of [checked.signer, checked.stamper]) {
    for (const { cert, issuer } of await chainToAnchor(leaf, pool, anchors)) {
      addUnique(data.certs, derOf(cert));
      addUnique(data.certs, derOf(issuer));
      // A CA both chains share has its status fetched once.
      if (done.some((der) => sameBytes(der, derOf(cert)))) continue;
      done.push(derOf(cert));
      const status = await fetchStatus(cert, issuer, checked.sealedAt, options);
      if (status.ocsp) addUnique(data.ocsps, status.ocsp);
      if (status.crl) addUnique(data.crls, status.crl);
    }
  }
  return data;
}

/** The sealed file, made long-term: its validation data added in one more incremental update. */
export async function addValidationData(sealed: Uint8Array, trustAnchors: readonly Uint8Array[], options: LongTermOptions = {}): Promise<Uint8Array> {
  const data = await validationDataFor(sealed, trustAnchors, options);
  const tail = dssUpdate(sealed, data, await vriKeyOf(readSeal(sealed).contents));
  const out = new Uint8Array(sealed.length + tail.length);
  out.set(sealed);
  out.set(tail, sealed.length);
  return out;
}
