import { createHash, createPublicKey, verify as verifySignature, webcrypto } from 'node:crypto';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { SealError, type SealSigner, type Timestamper } from './types';

/**
 * The CMS signature inside a PAdES seal (#70): a detached CAdES signature
 * over the PDF's byte ranges, as ETSI EN 319 142-1 baseline B-T asks.
 *
 *   signed attributes:   content-type (id-data), message-digest,
 *                        signing-certificate-v2 (the seal certificate's hash);
 *                        never signing-time (the PDF's /M carries the claim)
 *   unsigned attribute:  signature-time-stamp, an RFC 3161 token over the
 *                        signature value
 *
 * The digest of the signed attributes is what the provider signs, so the key
 * never leaves it and the document never reaches it.
 */

pkijs.setEngine('node', new pkijs.CryptoEngine({ name: 'node', crypto: webcrypto as unknown as Crypto }));

export const OID = {
  data: '1.2.840.113549.1.7.1',
  signedData: '1.2.840.113549.1.7.2',
  contentType: '1.2.840.113549.1.9.3',
  messageDigest: '1.2.840.113549.1.9.4',
  signingTime: '1.2.840.113549.1.9.5',
  signingCertificateV2: '1.2.840.113549.1.9.16.2.47',
  signatureTimeStampToken: '1.2.840.113549.1.9.16.2.14',
  tstInfo: '1.2.840.113549.1.9.16.1.4',
  sha256: '2.16.840.1.101.3.4.2.1',
  rsaEncryption: '1.2.840.113549.1.1.1',
  sha256WithRSA: '1.2.840.113549.1.1.11',
  ecPublicKey: '1.2.840.10045.2.1',
  ecdsaWithSHA256: '1.2.840.10045.4.3.2',
  timeStamping: '1.3.6.1.5.5.7.3.8',
} as const;

export const sha256 = (...parts: Uint8Array[]) => {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return new Uint8Array(hash.digest());
};
const view = (bytes: Uint8Array) => new Uint8Array(bytes);
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, i) => byte === b[i]);
const compare = (a: Uint8Array, b: Uint8Array) => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
};

function parse<T>(der: Uint8Array, read: (schema: asn1js.AsnType) => T, what: string): T {
  const asn = asn1js.fromBER(view(der));
  if (asn.offset === -1) throw new SealError('MALFORMED', `${what} is not DER`);
  try {
    return read(asn.result);
  } catch {
    throw new SealError('MALFORMED', `${what} is not what it should be`);
  }
}

export const parseCertificate = (der: Uint8Array) => parse(der, (schema) => new pkijs.Certificate({ schema }), 'a certificate');

/** SigningCertificateV2 ::= SEQUENCE { certs SEQUENCE OF ESSCertIDv2 }, with SHA-256, the default, left implicit. */
function signingCertificateV2(certDer: Uint8Array): pkijs.Attribute {
  const essCertIdV2 = new asn1js.Sequence({ value: [new asn1js.OctetString({ valueHex: sha256(certDer) })] });
  return new pkijs.Attribute({ type: OID.signingCertificateV2, values: [new asn1js.Sequence({ value: [new asn1js.Sequence({ value: [essCertIdV2] })] })] });
}

/** The DER of the signed attributes as a SET OF, sorted as DER requires: what is hashed and signed. */
function encodeSignedAttributes(attributes: pkijs.Attribute[]): { sorted: pkijs.Attribute[]; der: Uint8Array } {
  const sorted = attributes
    .map((attribute) => ({ attribute, der: new Uint8Array(attribute.toSchema().toBER(false)) }))
    .sort((a, b) => compare(a.der, b.der))
    .map((entry) => entry.attribute);
  const der = new Uint8Array(new asn1js.Set({ value: sorted.map((a) => a.toSchema()) }).toBER(false));
  return { sorted, der };
}

export interface CmsSignature {
  /** The DER ContentInfo for the PDF's /Contents. */
  der: Uint8Array;
  /** The seal certificate. */
  signer: pkijs.Certificate;
}

/** Signs the digest of a PDF's byte ranges: a detached CAdES signature with a signature timestamp. */
export async function signDetached(contentDigest: Uint8Array, signer: SealSigner, timestamper: Timestamper): Promise<CmsSignature> {
  const chainDer = await signer.certificates();
  if (chainDer.length === 0) throw new SealError('SIGNER_REFUSED', 'the provider gave no seal certificate');
  const chain = chainDer.map(parseCertificate);
  const [leaf] = chain;
  // The seal certificate's key says which signature to expect; the provider's word is not asked.
  const keyAlgorithm = leaf.subjectPublicKeyInfo.algorithm.algorithmId;
  if (keyAlgorithm !== OID.rsaEncryption && keyAlgorithm !== OID.ecPublicKey) throw new SealError('SIGNER_REFUSED', 'the seal key is neither RSA nor ECDSA');

  const { sorted, der: toBeSigned } = encodeSignedAttributes([
    new pkijs.Attribute({ type: OID.contentType, values: [new asn1js.ObjectIdentifier({ value: OID.data })] }),
    new pkijs.Attribute({ type: OID.messageDigest, values: [new asn1js.OctetString({ valueHex: contentDigest })] }),
    signingCertificateV2(chainDer[0]),
  ]);
  const signature = await signer.signDigest(sha256(toBeSigned));
  if (!signsWith(leaf, toBeSigned, signature)) throw new SealError('SIGNER_REFUSED', 'the provider’s signature does not verify against the seal certificate');

  const token = await timestamper.timestamp(sha256(signature));
  const tst = await readTimestampToken(token);
  if (!sameBytes(tst.imprint, sha256(signature))) throw new SealError('TIMESTAMP_REFUSED', 'the timestamp is not over this signature');

  const signerInfo = new pkijs.SignerInfo({
    version: 1,
    sid: new pkijs.IssuerAndSerialNumber({ issuer: leaf.issuer, serialNumber: leaf.serialNumber }),
    digestAlgorithm: new pkijs.AlgorithmIdentifier({ algorithmId: OID.sha256 }),
    signedAttrs: new pkijs.SignedAndUnsignedAttributes({ type: 0, attributes: sorted }),
    signatureAlgorithm: new pkijs.AlgorithmIdentifier(
      keyAlgorithm === OID.rsaEncryption ? { algorithmId: OID.sha256WithRSA, algorithmParams: new asn1js.Null() } : { algorithmId: OID.ecdsaWithSHA256 },
    ),
    signature: new asn1js.OctetString({ valueHex: signature }),
    unsignedAttrs: new pkijs.SignedAndUnsignedAttributes({
      type: 1,
      attributes: [new pkijs.Attribute({ type: OID.signatureTimeStampToken, values: [asn1js.fromBER(view(token)).result] })],
    }),
  });
  const signedData = new pkijs.SignedData({
    version: 1,
    digestAlgorithms: [new pkijs.AlgorithmIdentifier({ algorithmId: OID.sha256 })],
    encapContentInfo: new pkijs.EncapsulatedContentInfo({ eContentType: OID.data }),
    certificates: chain,
    signerInfos: [signerInfo],
  });
  const contentInfo = new pkijs.ContentInfo({ contentType: OID.signedData, content: signedData.toSchema(true) });
  return { der: new Uint8Array(contentInfo.toSchema().toBER(false)), signer: leaf };
}

/** Whether `signature` is the certificate's key's SHA-256 signature over `data` (PKCS #1 v1.5, or DER ECDSA). */
function signsWith(cert: pkijs.Certificate, data: Uint8Array, signature: Uint8Array): boolean {
  if (signature.length === 0) return false;
  try {
    const key = createPublicKey({ key: Buffer.from(cert.subjectPublicKeyInfo.toSchema().toBER(false)), format: 'der', type: 'spki' });
    return verifySignature('sha256', data, { key, dsaEncoding: 'der' }, signature);
  } catch {
    return false;
  }
}

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
    serial: Buffer.from(tstInfo.serialNumber.valueBlock.valueHexView).toString('hex'),
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
export async function checkDetached(der: Uint8Array, content: Uint8Array, trustAnchors: Uint8Array[]): Promise<CmsCheck> {
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
  if (!sameBytes(tst.imprint, sha256(new Uint8Array(signerInfo.signature.valueBlock.valueHexView)))) {
    throw new SealError('BAD_TIMESTAMP', 'the timestamp is not over this signature');
  }
  if (!tst.tsa) throw new SealError('BAD_TIMESTAMP', 'the timestamp names no timestamping authority');
  // The seal certificate must have chained to an anchor, and been valid, when the timestamp says it signed;
  // a wrong time cannot help, since the timestamp's own check below must pass too.
  await verifyChain(signedData, content, anchors, tst.genTime, 'the seal certificate', 'UNTRUSTED');
  // pkijs checks a TSTInfo's imprint against the bytes it is handed: the signature value.
  const stamper = await verifyChain(tst.signedData, new Uint8Array(signerInfo.signature.valueBlock.valueHexView), anchors, tst.genTime, 'the timestamp', 'BAD_TIMESTAMP');
  if (!hasTimeStampingUsage(stamper)) throw new SealError('BAD_TIMESTAMP', 'the timestamp was not signed by a timestamping authority');

  return { signer, sealedAt: tst.genTime, timestampSerial: tst.serial };
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
