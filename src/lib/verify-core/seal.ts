import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { bytesToHex, hexToBytes } from 'viem';
import { pemCertificates } from '../eseal/pem';
import { SealError, type SealErrorCode } from '../eseal/types';
import { readDssUpdate, vriKeyOf } from './dss';
import { ascii, ensureEngine, OID, parse, parseCertificate, sameBytes, sha256, view } from './pki';
import { chainToAnchor, statusOf, type ValidationData } from './revocation';

export { OID, parseCertificate, sameBytes, sha256 } from './pki';

/**
 * Checking the firm's electronic seal on a PDF (#70), in the browser as in
 * Node: a PAdES signature (ETSI EN 319 142-1 baseline B-T), a detached CAdES
 * signature over the file's byte ranges with an RFC 3161 timestamp over the
 * signature value. A long-term seal (baseline B-LT, #119) also carries, in one
 * more update after it, its certificates' status at the timestamp's time,
 * which is checked too. The worker checks every seal it makes with this, and the
 * verifiers check a matched copy's seal with it (#120), against the roots the
 * firm publishes. A seal never changes a verdict; only the registry decides.
 *
 * Signing lives in src/lib/eseal/, which needs Node.
 */

export interface TimestampReading {
  /** What the token stamps: the SHA-256 digest it was asked for. */
  imprint: Uint8Array;
  genTime: Date;
  serial: string;
  /** The nonce the request carried, when it carried one. */
  nonce: bigint | null;
  /** The authority's policy under which it stamped. */
  policy: string;
  /** The token as CMS, for verifying its own signature. */
  signedData: pkijs.SignedData;
  /** The TSA certificate, when the token carries it. */
  tsa: pkijs.Certificate | null;
}

/** Reads an RFC 3161 TimeStampToken: a SignedData over a TSTInfo, its imprint SHA-256. */
export async function readTimestampToken(token: Uint8Array): Promise<TimestampReading> {
  const contentInfo = parse(token, (schema) => new pkijs.ContentInfo({ schema }), 'the timestamp token');
  if (contentInfo.contentType !== OID.signedData) throw new SealError('BAD_TIMESTAMP', 'the timestamp token is not signed data');
  const signedData = new pkijs.SignedData({ schema: contentInfo.content });
  const encap = signedData.encapContentInfo;
  if (encap.eContentType !== OID.tstInfo || !encap.eContent) throw new SealError('BAD_TIMESTAMP', 'the timestamp token holds no TSTInfo');
  // Some authorities write the TSTInfo as a constructed (BER) OCTET STRING; pkijs's verify reads only a
  // primitive one. The bytes are the same either way, so the signature over them is unchanged.
  if (encap.eContent.idBlock.isConstructed) encap.eContent = new asn1js.OctetString({ valueHex: encap.eContent.getValue() });
  const tstInfo = parse(new Uint8Array(encap.eContent.getValue()), (schema) => new pkijs.TSTInfo({ schema }), 'the TSTInfo');
  if (tstInfo.messageImprint.hashAlgorithm.algorithmId !== OID.sha256) throw new SealError('BAD_TIMESTAMP', 'the timestamp is not over a SHA-256 digest');
  const tsa = (signedData.certificates ?? []).find((c): c is pkijs.Certificate => c instanceof pkijs.Certificate && hasTimeStampingUsage(c)) ?? null;
  return {
    imprint: new Uint8Array(tstInfo.messageImprint.hashedMessage.valueBlock.valueHexView),
    genTime: tstInfo.genTime,
    serial: bytesToHex(new Uint8Array(tstInfo.serialNumber.valueBlock.valueHexView)).slice(2),
    nonce: tstInfo.nonce ? tstInfo.nonce.toBigInt() : null,
    policy: tstInfo.policy,
    signedData,
    tsa,
  };
}

function hasTimeStampingUsage(cert: pkijs.Certificate) {
  const eku = cert.extensions?.find((e) => e.extnID === '2.5.29.37');
  return !!eku && (eku.parsedValue as pkijs.ExtKeyUsage | undefined)?.keyPurposes.includes(OID.timeStamping) === true;
}

export interface CmsCheck {
  signer: pkijs.Certificate;
  /** The certificates the signature carries. */
  certificates: pkijs.Certificate[];
  /** The timestamping authority's certificate, and the certificates its token carries. */
  stamper: pkijs.Certificate;
  stamperCertificates: pkijs.Certificate[];
  /** The time the timestamping authority vouches for. */
  sealedAt: Date;
  timestampSerial: string;
}

/**
 * Checks a detached CAdES signature over `content` from the PDF's byte
 * ranges: the digest, the signature, the seal certificate named in the signed
 * attributes, a chain to one of `trustAnchors`, and the timestamp over the
 * signature, itself signed by a timestamping authority that chains to them.
 */
export async function checkDetached(der: Uint8Array, content: Uint8Array, trustAnchors: readonly Uint8Array[]): Promise<CmsCheck> {
  ensureEngine();
  const contentInfo = parse(der, (schema) => new pkijs.ContentInfo({ schema }), 'the signature');
  if (contentInfo.contentType !== OID.signedData) throw new SealError('MALFORMED', 'the signature is not CMS signed data');
  const signedData = new pkijs.SignedData({ schema: contentInfo.content });
  if (signedData.signerInfos.length !== 1) throw new SealError('MALFORMED', 'a seal has exactly one signer');
  if (signedData.encapContentInfo.eContent) throw new SealError('MALFORMED', 'a PAdES signature is detached');
  const [signerInfo] = signedData.signerInfos;
  const attributes = signerInfo.signedAttrs?.attributes ?? [];
  const attribute = (type: string) => attributes.filter((a) => a.type === type);

  const digests = attribute(OID.messageDigest);
  if (digests.length !== 1) throw new SealError('MALFORMED', 'the signature carries no single message digest');
  const signed = new Uint8Array((digests[0].values[0] as asn1js.OctetString).valueBlock.valueHexView);
  if (!sameBytes(signed, sha256(content))) throw new SealError('DIGEST_MISMATCH', 'the file is not what was sealed');
  if (attribute(OID.signingTime).length) throw new SealError('MALFORMED', 'a PAdES signature carries no signing-time attribute');

  const anchors = trustAnchors.map(parseCertificate);
  const verified = await signedData
    .verify({ signer: 0, data: view(content).buffer as ArrayBuffer, checkChain: false, extendedMode: true })
    .catch((error: unknown) => error as pkijs.SignedDataVerifyResult);
  if (!verified.signatureVerified || !verified.signerCertificate) throw new SealError('BAD_SIGNATURE', 'the signature does not verify');
  const signer = verified.signerCertificate;

  const pinned = attribute(OID.signingCertificateV2);
  const signerDer = new Uint8Array(signer.toSchema().toBER(false));
  const certHash = (() => {
    try {
      const certs = (pinned[0].values[0] as asn1js.Sequence).valueBlock.value[0] as asn1js.Sequence;
      const first = (certs.valueBlock.value[0] as asn1js.Sequence).valueBlock.value;
      // A hash algorithm present before the hash would not be SHA-256's default form.
      if (first[0] instanceof asn1js.Sequence) return null;
      return new Uint8Array((first[0] as asn1js.OctetString).valueBlock.valueHexView);
    } catch {
      return null;
    }
  })();
  if (pinned.length !== 1 || !certHash || !sameBytes(certHash, sha256(signerDer))) throw new SealError('WRONG_CERTIFICATE', 'the signed attributes do not name the certificate that signed');

  const timestamps = (signerInfo.unsignedAttrs?.attributes ?? []).filter((a) => a.type === OID.signatureTimeStampToken);
  if (timestamps.length !== 1) throw new SealError('BAD_TIMESTAMP', 'the seal carries no single signature timestamp');
  const token = new Uint8Array(timestamps[0].values[0].toBER(false));
  const tst = await readTimestampToken(token);
  const signatureValue = new Uint8Array(signerInfo.signature.valueBlock.valueHexView);
  if (!sameBytes(tst.imprint, sha256(signatureValue))) throw new SealError('BAD_TIMESTAMP', 'the timestamp is not over this signature');
  if (!tst.tsa) throw new SealError('BAD_TIMESTAMP', 'the timestamp names no timestamping authority');
  // The seal certificate must have chained to an anchor, and been valid, when the timestamp says it signed;
  // a wrong time cannot help, since the timestamp's own check below must pass too.
  await verifyChain(signedData, content, anchors, tst.genTime, 'the seal certificate', 'UNTRUSTED');
  // pkijs checks a TSTInfo's imprint against the bytes it is handed: the signature value.
  const stamper = await verifyChain(tst.signedData, signatureValue, anchors, tst.genTime, 'the timestamp', 'BAD_TIMESTAMP');
  if (!hasTimeStampingUsage(stamper)) throw new SealError('BAD_TIMESTAMP', 'the timestamp was not signed by a timestamping authority');

  const carried = (data: pkijs.SignedData) => (data.certificates ?? []).filter((c): c is pkijs.Certificate => c instanceof pkijs.Certificate);
  return { signer, certificates: carried(signedData), stamper, stamperCertificates: carried(tst.signedData), sealedAt: tst.genTime, timestampSerial: tst.serial };
}

/**
 * The statuses a long-term seal carries (#119): one for every certificate from
 * the seal's and the timestamping authority's up to a trust anchor, each good
 * at the timestamp's time (src/lib/verify-core/revocation.ts).
 */
export async function checkValidationData(checked: CmsCheck, data: ValidationData, trustAnchors: readonly Uint8Array[], now = new Date()): Promise<void> {
  const anchors = trustAnchors.map(parseCertificate);
  const pool = [...checked.certificates, ...checked.stamperCertificates, ...data.certs.map(parseCertificate)];
  for (const leaf of [checked.signer, checked.stamper]) {
    for (const { cert, issuer } of await chainToAnchor(leaf, pool, anchors)) await statusOf(cert, issuer, data, checked.sealedAt, now);
  }
}

/** The signer's signature, and its certificate chain to a trust anchor at `at`; returns the signer's certificate. */
async function verifyChain(signedData: pkijs.SignedData, content: Uint8Array, anchors: pkijs.Certificate[], at: Date, what: string, code: 'UNTRUSTED' | 'BAD_TIMESTAMP') {
  if (anchors.length === 0) throw new SealError('UNTRUSTED', 'no trust anchors were given');
  const result = await signedData
    .verify({ signer: 0, data: view(content).buffer as ArrayBuffer, checkChain: true, trustedCerts: anchors, checkDate: at, extendedMode: true })
    .catch((error: unknown) => error as pkijs.SignedDataVerifyResult);
  if (result.signatureVerified !== true || result.signerCertificateVerified !== true || !result.signerCertificate) {
    throw new SealError(code, `${what} does not verify, or does not chain to a trusted root at ${at.toISOString()}`);
  }
  return result.signerCertificate;
}

// ── The seal in the PDF ──

const BYTE_RANGE = Array.from('/ByteRange', (c) => c.charCodeAt(0));

function lastIndexOf(bytes: Uint8Array, pattern: readonly number[]): number {
  outer: for (let i = bytes.length - pattern.length; i >= 0; i--) {
    for (let j = 0; j < pattern.length; j++) if (bytes[i + j] !== pattern[j]) continue outer;
    return i;
  }
  return -1;
}

export interface SealReading {
  /** The bytes the seal covers: the whole signed revision but the signature itself. */
  content: Uint8Array;
  /** The CMS signature, without the padding. */
  cms: Uint8Array;
  /** The signature's /Contents as written, padding included: what its VRI key is the hash of. */
  contents: Uint8Array;
  /** Where the signature's update begins: the file before it was sealed is the bytes up to here. */
  byteRange: [number, number, number, number];
  /** The validation data a long-term seal carries after the signed revision (#119), or null. */
  dss: { data: ValidationData; vriKey: string } | null;
}

/** Whether a file carries a signature dictionary at all. */
export const carriesSeal = (bytes: Uint8Array) => lastIndexOf(bytes, BYTE_RANGE) >= 0;

/**
 * The seal of a sealed file: the last signature, which must cover the whole
 * file but its own contents, or all of it but the validation data a long-term
 * seal adds after it, and nothing else (#119).
 */
export function readSeal(bytes: Uint8Array): SealReading {
  const at = lastIndexOf(bytes, BYTE_RANGE);
  if (at < 0) throw new SealError('NO_SEAL', 'the file carries no signature');
  const match = /^\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/.exec(ascii(bytes.subarray(at, at + 200)));
  if (!match) throw new SealError('MALFORMED', 'the byte range cannot be read');
  const range = match.slice(1, 5).map(Number) as [number, number, number, number];
  const [start, firstLength, secondStart, secondLength] = range;
  const signedEnd = secondStart + secondLength;
  if (start !== 0 || firstLength >= secondStart || signedEnd > bytes.length) {
    throw new SealError('NOT_WHOLE_FILE', 'the signature does not cover the whole file but itself');
  }
  if (bytes[firstLength] !== 0x3c || bytes[secondStart - 1] !== 0x3e) throw new SealError('NOT_WHOLE_FILE', 'the byte range leaves out more than the signature');
  const hex = ascii(bytes.subarray(firstLength + 1, secondStart - 1));
  if (!/^[0-9A-Fa-f]*$/.test(hex) || hex.length % 2) throw new SealError('MALFORMED', 'the signature contents are not hex');
  const padded = hexToBytes(`0x${hex}`);
  // The DER length says where the signature ends; the rest is the placeholder's zeros.
  const cms = padded.slice(0, derLength(padded));
  if (padded.subarray(cms.length).some((b) => b !== 0)) throw new SealError('MALFORMED', 'bytes follow the signature in its contents');
  const content = new Uint8Array(firstLength + secondLength);
  content.set(bytes.subarray(0, firstLength));
  content.set(bytes.subarray(secondStart, signedEnd), firstLength);
  const dss = signedEnd === bytes.length ? null : readDssUpdate(bytes, signedEnd);
  return { content, cms, contents: padded, byteRange: range, dss };
}

function derLength(bytes: Uint8Array): number {
  if (bytes[0] !== 0x30) throw new SealError('MALFORMED', 'the signature is not a DER sequence');
  const first = bytes[1];
  if (first < 0x80) return 2 + first;
  const n = first & 0x7f;
  if (n === 0 || n > 4) throw new SealError('MALFORMED', 'the signature has an unreadable length');
  let length = 0;
  for (let i = 0; i < n; i++) length = length * 256 + bytes[2 + i];
  if (2 + n + length > bytes.length) throw new SealError('MALFORMED', 'the signature is longer than its contents');
  return 2 + n + length;
}

export interface SealCheck {
  /** The seal certificate's subject, as a string. */
  signer: string;
  /** The time the timestamping authority vouches for. */
  sealedAt: Date;
  timestampSerial: string;
  /** Whether the seal carries its certificates' status at that time, all good (PAdES B-LT, #119). */
  longTerm: boolean;
}

const NAME_FIELDS: Record<string, string> = { '2.5.4.3': 'CN', '2.5.4.10': 'O', '2.5.4.6': 'C' };

/**
 * Checks a sealed copy: its seal covers the whole file but itself, the file
 * before the seal is `stamped` (when given), and the signature, the seal
 * certificate, its chain and the timestamp all hold against `trustAnchors`.
 */
export async function checkSeal(sealed: Uint8Array, trustAnchors: readonly Uint8Array[], stamped?: Uint8Array): Promise<SealCheck> {
  const seal = readSeal(sealed);
  if (stamped && (sealed.length <= stamped.length || !sameBytes(sealed.subarray(0, stamped.length), stamped))) {
    throw new SealError('NOT_WHOLE_FILE', 'the sealed file does not begin with the stamped file');
  }
  if (stamped && seal.byteRange[1] < stamped.length) throw new SealError('NOT_WHOLE_FILE', 'the signature lies inside the stamped file');
  const checked = await checkDetached(seal.cms, seal.content, trustAnchors);
  if (seal.dss) {
    if (seal.dss.vriKey !== (await vriKeyOf(seal.contents))) throw new SealError('NOT_WHOLE_FILE', 'the validation data is filed under another signature');
    await checkValidationData(checked, seal.dss.data, trustAnchors);
  }
  return {
    signer: checked.signer.subject.typesAndValues.map((tv) => `${NAME_FIELDS[tv.type] ?? tv.type}=${tv.value.valueBlock.value}`).join(', '),
    sealedAt: checked.sealedAt,
    timestampSerial: checked.timestampSerial,
    longTerm: seal.dss !== null,
  };
}

// ── What a verifier shows ──

/**
 * A matched copy's seal, as the verifiers show it beside the verdict (#120).
 * None of these changes the verdict, and none says authentic: a seal says who
 * sealed the file and when, the registry says whether it is the file anchored.
 */
export type SealStatus =
  /** The seal holds, against the roots the firm publishes. */
  | { status: 'SEALED'; signer: string; sealedAt: number; longTerm: boolean }
  /** The file carries no signature. */
  | { status: 'NOT_SEALED' }
  /** The verifier was given no roots to check a seal against. */
  | { status: 'NO_ROOTS' }
  /** The file carries a signature that does not check: altered, or from someone the roots do not vouch for. */
  | { status: 'INVALID'; reason: SealErrorCode };

export async function sealStatusFor(bytes: Uint8Array, roots: readonly Uint8Array[]): Promise<SealStatus> {
  if (!carriesSeal(bytes)) return { status: 'NOT_SEALED' };
  if (roots.length === 0) return { status: 'NO_ROOTS' };
  try {
    const checked = await checkSeal(bytes, roots);
    return { status: 'SEALED', signer: checked.signer, sealedAt: Math.floor(checked.sealedAt.getTime() / 1000), longTerm: checked.longTerm };
  } catch (error) {
    return { status: 'INVALID', reason: error instanceof SealError ? error.code : 'MALFORMED' };
  }
}

/** Certificates in a PEM text, as DER; each must read as a certificate. */
export function certificatesFromPem(text: string): Uint8Array[] {
  const blocks = pemCertificates(text);
  for (const der of blocks) parseCertificate(der);
  return blocks;
}
