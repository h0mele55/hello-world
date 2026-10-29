import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { SealError } from '../eseal/types';
import { ensureEngine, OID, parse, sameBytes, view } from './pki';

/**
 * A certificate's status at a seal's time (#119), from an OCSP response or a
 * CRL. A long-term seal (PAdES B-LT) carries one for every certificate it
 * relies on but the trust anchors, so it can still be checked once those
 * certificates expire or their CA's services go away. The worker checks each
 * status with this before it adds it to a copy, and every verifier checks the
 * statuses a copy carries with it again. Isomorphic: WebCrypto only.
 *
 * A status counts only when it is:
 *   - about this certificate, from its issuer;
 *   - signed by the issuer, or by a responder the issuer delegated to
 *     (id-kp-OCSPSigning, with id-pkix-ocsp-nocheck, valid when it answered);
 *   - current at the seal's time: its nextUpdate is no earlier than the
 *     timestamp, or, without one, it was made at most a day before it; and
 *     not dated in the future;
 *   - good. Revoked is CERTIFICATE_REVOKED; anything else is REVOCATION_REFUSED.
 */

/** How far a status's clock may run ahead of ours. */
const CLOCK_SKEW_MS = 5 * 60 * 1000;
/** How long a status with no nextUpdate speaks for. */
const WITHOUT_NEXT_UPDATE_MS = 24 * 60 * 60 * 1000;

export interface ValidationData {
  certs: Uint8Array[];
  ocsps: Uint8Array[];
  crls: Uint8Array[];
}

export interface StatusSources {
  ocsp: string[];
  crl: string[];
}

const refused = (message: string) => new SealError('REVOCATION_REFUSED', message);
const extension = (cert: pkijs.Certificate, id: string) => cert.extensions?.find((e) => e.extnID === id);
export const derOf = (cert: pkijs.Certificate) => new Uint8Array(cert.toSchema().toBER(false));
const sameCert = (a: pkijs.Certificate, b: pkijs.Certificate) => sameBytes(derOf(a), derOf(b));
export const subjectOf = (cert: pkijs.Certificate) => cert.subject.typesAndValues.map((tv) => String(tv.value.valueBlock.value)).join(', ');
const serialOf = (cert: pkijs.Certificate) => view(cert.serialNumber.valueBlock.valueHexView);
/** The URLs a GeneralName list names (uniformResourceIdentifier, type 6). */
const urisOf = (names: unknown): string[] => (Array.isArray(names) ? names.filter((n: pkijs.GeneralName) => n.type === 6).map((n: pkijs.GeneralName) => String(n.value)) : []);

/** Where a certificate says its status is kept: OCSP responders, then CRLs. */
export function revocationSources(cert: pkijs.Certificate): StatusSources {
  const aia = extension(cert, OID.authorityInfoAccess)?.parsedValue as pkijs.InfoAccess | undefined;
  const ocsp = (aia?.accessDescriptions ?? []).filter((d) => d.accessMethod === OID.ocspAccess).flatMap((d) => urisOf([d.accessLocation]));
  const points = extension(cert, OID.crlDistributionPoints)?.parsedValue as pkijs.CRLDistributionPoints | undefined;
  const crl = (points?.distributionPoints ?? []).flatMap((p) => urisOf(p.distributionPoint));
  return { ocsp, crl };
}

/** The certificate in `pool` that issued `cert`: named as its issuer, and whose key verifies its signature. */
export async function issuerOf(cert: pkijs.Certificate, pool: readonly pkijs.Certificate[]): Promise<pkijs.Certificate | null> {
  ensureEngine();
  for (const candidate of pool) {
    if (!candidate.subject.isEqual(cert.issuer)) continue;
    if (await cert.verify(candidate).catch(() => false)) return candidate;
  }
  return null;
}

/** Every certificate from `leaf` up to, not including, a trust anchor, each with the certificate that issued it. */
export async function chainToAnchor(leaf: pkijs.Certificate, pool: readonly pkijs.Certificate[], anchors: readonly pkijs.Certificate[]): Promise<{ cert: pkijs.Certificate; issuer: pkijs.Certificate }[]> {
  const out: { cert: pkijs.Certificate; issuer: pkijs.Certificate }[] = [];
  let cert = leaf;
  for (let depth = 0; depth < 8; depth++) {
    if (anchors.some((anchor) => sameCert(anchor, cert))) return out;
    const issuer = await issuerOf(cert, [...anchors, ...pool]);
    if (!issuer) throw new SealError('UNTRUSTED', `nothing given issued ${subjectOf(cert)}`);
    out.push({ cert, issuer });
    cert = issuer;
  }
  throw new SealError('UNTRUSTED', 'the chain to a trusted root is too long');
}

function current(thisUpdate: Date, nextUpdate: Date | undefined, at: Date, now: Date, what: string) {
  if (thisUpdate.getTime() > now.getTime() + CLOCK_SKEW_MS) throw refused(`${what} is dated in the future`);
  const stale = nextUpdate ? nextUpdate.getTime() < at.getTime() : thisUpdate.getTime() < at.getTime() - WITHOUT_NEXT_UPDATE_MS;
  if (stale) throw refused(`${what} was not current at ${at.toISOString()}`);
}

async function digest(algorithm: 'SHA-1' | 'SHA-256', data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await globalThis.crypto.subtle.digest(algorithm, view(data)));
}

/** Whether a CertID names `cert` as issued by `issuer`, under SHA-1 or SHA-256. */
async function names(id: pkijs.CertID, cert: pkijs.Certificate, issuer: pkijs.Certificate): Promise<boolean> {
  const algorithm = id.hashAlgorithm.algorithmId === OID.sha1 ? 'SHA-1' : id.hashAlgorithm.algorithmId === OID.sha256 ? 'SHA-256' : null;
  if (!algorithm) return false;
  const nameHash = await digest(algorithm, new Uint8Array(issuer.subject.toSchema().toBER(false)));
  const keyHash = await digest(algorithm, view(issuer.subjectPublicKeyInfo.subjectPublicKey.valueBlock.valueHexView));
  return (
    sameBytes(view(id.issuerNameHash.valueBlock.valueHexView), nameHash) &&
    sameBytes(view(id.issuerKeyHash.valueBlock.valueHexView), keyHash) &&
    sameBytes(view(id.serialNumber.valueBlock.valueHexView), serialOf(cert))
  );
}

const hasUsage = (cert: pkijs.Certificate, usage: string) => (extension(cert, OID.extKeyUsage)?.parsedValue as pkijs.ExtKeyUsage | undefined)?.keyPurposes.includes(usage) === true;
const validAt = (cert: pkijs.Certificate, at: Date) => cert.notBefore.value.getTime() <= at.getTime() && at.getTime() <= cert.notAfter.value.getTime();

/** Who signed a basic OCSP response: the issuer, or a responder it delegated to and that needs no status of its own. */
async function responderOf(basic: pkijs.BasicOCSPResponse, issuer: pkijs.Certificate): Promise<pkijs.Certificate> {
  const id: unknown = basic.tbsResponseData.responderID;
  const candidates = [issuer, ...(basic.certs ?? [])];
  let responder: pkijs.Certificate | undefined;
  if (id instanceof pkijs.RelativeDistinguishedNames) {
    responder = candidates.find((c) => c.subject.isEqual(id));
  } else if (id instanceof asn1js.OctetString) {
    for (const candidate of candidates) {
      if (sameBytes(await digest('SHA-1', view(candidate.subjectPublicKeyInfo.subjectPublicKey.valueBlock.valueHexView)), view(id.valueBlock.valueHexView))) responder = candidate;
    }
  }
  if (!responder) throw refused('the OCSP response names a responder it does not carry');
  if (sameCert(responder, issuer)) return responder;
  const producedAt = basic.tbsResponseData.producedAt;
  if (!responder.issuer.isEqual(issuer.subject) || !(await responder.verify(issuer).catch(() => false))) throw refused('the OCSP responder was not delegated by the certificate’s issuer');
  if (!hasUsage(responder, OID.ocspSigning)) throw refused('the OCSP responder’s certificate is not for signing OCSP responses');
  if (!validAt(responder, producedAt)) throw refused('the OCSP responder’s certificate was not valid when it answered');
  // Without id-pkix-ocsp-nocheck the responder's own status would be needed too, and a seal does not chase it.
  if (!extension(responder, OID.ocspNoCheck)) throw refused('the delegated OCSP responder’s certificate carries no ocsp-nocheck');
  return responder;
}

/**
 * Reads an OCSP response for `cert`: GOOD when it shows the certificate good
 * at `at`, null when it is about another certificate; throws when it is about
 * this one and does not hold.
 */
export async function ocspStatus(der: Uint8Array, cert: pkijs.Certificate, issuer: pkijs.Certificate, at: Date, now: Date): Promise<'GOOD' | null> {
  ensureEngine();
  const response = parse(der, (schema) => new pkijs.OCSPResponse({ schema }), 'an OCSP response');
  const status = response.responseStatus.valueBlock.valueDec;
  if (status !== 0) throw refused(`the OCSP responder answered status ${status}`);
  if (!response.responseBytes || response.responseBytes.responseType !== OID.basicOcspResponse) throw refused('the OCSP response is not a basic one');
  const basic = parse(view(response.responseBytes.response.valueBlock.valueHexView), (schema) => new pkijs.BasicOCSPResponse({ schema }), 'a basic OCSP response');
  let single: pkijs.SingleResponse | undefined;
  for (const candidate of basic.tbsResponseData.responses) if (await names(candidate.certID, cert, issuer)) single = candidate;
  if (!single) return null;

  const responder = await responderOf(basic, issuer);
  const engine = pkijs.getEngine().crypto!;
  const signed = await engine
    .verifyWithPublicKey(view(basic.tbsResponseData.tbsView), basic.signature, responder.subjectPublicKeyInfo, basic.signatureAlgorithm)
    .catch(() => false);
  if (!signed) throw refused('the OCSP response’s signature does not verify');
  current(single.thisUpdate, single.nextUpdate, at, now, 'the OCSP response');
  const tag = (single.certStatus as asn1js.BaseBlock).idBlock.tagNumber;
  if (tag === 1) throw new SealError('CERTIFICATE_REVOKED', `${subjectOf(cert)} is revoked`);
  if (tag !== 0) throw refused(`the OCSP responder does not know ${subjectOf(cert)}`);
  return 'GOOD';
}

const DELTA_CRL_INDICATOR = '2.5.29.27';
const ISSUING_DISTRIBUTION_POINT = '2.5.29.28';

/**
 * Reads a CRL for `cert`: GOOD when it is its issuer's, current at `at` and
 * does not list it; null when it is another issuer's; throws otherwise. A
 * delta CRL, or one that covers only some reasons or other issuers'
 * certificates, cannot show a certificate good on its own and is refused.
 */
export async function crlStatus(der: Uint8Array, cert: pkijs.Certificate, issuer: pkijs.Certificate, at: Date, now: Date): Promise<'GOOD' | null> {
  ensureEngine();
  const crl = parse(der, (schema) => new pkijs.CertificateRevocationList({ schema }), 'a CRL');
  if (!crl.issuer.isEqual(issuer.subject)) return null;
  if (!(await crl.verify({ issuerCertificate: issuer }).catch(() => false))) throw refused('the CRL is not signed by the certificate’s issuer');
  const extensions = crl.crlExtensions?.extensions ?? [];
  if (extensions.some((e) => e.extnID === DELTA_CRL_INDICATOR)) throw refused('a delta CRL alone cannot show a certificate good');
  const scope = extensions.find((e) => e.extnID === ISSUING_DISTRIBUTION_POINT)?.parsedValue as pkijs.IssuingDistributionPoint | undefined;
  if (scope && (scope.onlySomeReasons !== undefined || scope.indirectCRL)) throw refused('the CRL covers only some revocations');
  current(crl.thisUpdate.value, crl.nextUpdate?.value, at, now, 'the CRL');
  const serial = serialOf(cert);
  if ((crl.revokedCertificates ?? []).some((r) => sameBytes(view(r.userCertificate.valueBlock.valueHexView), serial))) {
    throw new SealError('CERTIFICATE_REVOKED', `${subjectOf(cert)} is revoked`);
  }
  return 'GOOD';
}

/**
 * The status, among those given, that shows `cert` good at `at`. One that
 * shows it revoked stops the search; with none that holds, the last refusal is
 * the reason.
 */
export async function statusOf(cert: pkijs.Certificate, issuer: pkijs.Certificate, data: Pick<ValidationData, 'ocsps' | 'crls'>, at: Date, now: Date): Promise<void> {
  let last: SealError | null = null;
  const attempts = [...data.ocsps.map((der) => () => ocspStatus(der, cert, issuer, at, now)), ...data.crls.map((der) => () => crlStatus(der, cert, issuer, at, now))];
  for (const attempt of attempts) {
    try {
      if ((await attempt()) === 'GOOD') return;
    } catch (error) {
      if (!(error instanceof SealError) || error.code === 'CERTIFICATE_REVOKED') throw error;
      last = error;
    }
  }
  throw last ?? refused(`no status given for ${subjectOf(cert)}`);
}
