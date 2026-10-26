import { createPublicKey, verify as verifySignature, webcrypto } from 'node:crypto';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { OID, parseCertificate, readTimestampToken, sameBytes, sha256 } from '../verify-core/seal';
import { SealError, type SealSigner, type Timestamper } from './types';

/**
 * Making the CMS signature inside a PAdES seal (#70): a detached CAdES
 * signature over the PDF's byte ranges, as ETSI EN 319 142-1 baseline B-T asks.
 *
 *   signed attributes:   content-type (id-data), message-digest,
 *                        signing-certificate-v2 (the seal certificate's hash);
 *                        never signing-time (the PDF's /M carries the claim)
 *   unsigned attribute:  signature-time-stamp, an RFC 3161 token over the
 *                        signature value
 *
 * The digest of the signed attributes is what the provider signs, so the key
 * never leaves it and the document never reaches it. Checking a seal is in
 * src/lib/verify-core/seal.ts, which the browser verifiers share.
 */

pkijs.setEngine('node', new pkijs.CryptoEngine({ name: 'node', crypto: webcrypto as unknown as Crypto }));

export { checkDetached, OID, parseCertificate, readTimestampToken, sha256, type CmsCheck, type TimestampReading } from '../verify-core/seal';

const view = (bytes: Uint8Array) => new Uint8Array(bytes);
const compare = (a: Uint8Array, b: Uint8Array) => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
};

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
