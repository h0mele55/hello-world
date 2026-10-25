import { constants, createPrivateKey, privateEncrypt, webcrypto } from 'node:crypto';
import { p256 } from '@noble/curves/nist';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { OID, sha256 } from '@/lib/eseal/cms';
import type { SealSigner, Timestamper } from '@/lib/eseal/types';

/**
 * A throwaway PKI for the seal's tests (#70): a root, a seal certificate it
 * issued, and a timestamping authority it issued, all made fresh in memory.
 * A real deployment's seal comes from a qualified trust service provider and
 * its timestamps from a qualified timestamping authority; these stand in for
 * both, through the same two interfaces.
 */

const subtle = webcrypto.subtle as unknown as SubtleCrypto;
const DAY = 24 * 60 * 60 * 1000;
const SHA256_DIGEST_INFO = Uint8Array.from(Buffer.from('3031300d060960864801650304020105000420', 'hex'));

type KeyPair = CryptoKeyPair;
const rsaKeys = () =>
  subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']) as Promise<KeyPair>;
const ecKeys = () => subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as Promise<KeyPair>;

const nameOf = (cn: string, org?: string) => {
  const name = new pkijs.RelativeDistinguishedNames();
  name.typesAndValues.push(new pkijs.AttributeTypeAndValue({ type: '2.5.4.6', value: new asn1js.PrintableString({ value: 'BG' }) }));
  if (org) name.typesAndValues.push(new pkijs.AttributeTypeAndValue({ type: '2.5.4.10', value: new asn1js.Utf8String({ value: org }) }));
  name.typesAndValues.push(new pkijs.AttributeTypeAndValue({ type: '2.5.4.3', value: new asn1js.Utf8String({ value: cn }) }));
  return name;
};

const extension = (extnID: string, critical: boolean, value: asn1js.AsnType) => new pkijs.Extension({ extnID, critical, extnValue: value.toBER(false) });
/** KeyUsage as a DER BIT STRING from its bit numbers (0 = digitalSignature). */
const keyUsage = (bits: number[]) => {
  const byte = bits.reduce((b, bit) => b | (0x80 >> bit), 0);
  const unused = Math.min(7, 7 - Math.max(...bits));
  return new asn1js.BitString({ valueHex: new Uint8Array([byte]), unusedBits: unused });
};

let serial = 1000;
async function issue(input: { cn: string; org?: string; keys: KeyPair; issuer?: { cert: pkijs.Certificate; keys: KeyPair }; ca?: boolean; tsa?: boolean; notBefore?: Date; notAfter?: Date }) {
  const cert = new pkijs.Certificate();
  cert.version = 2;
  cert.serialNumber = new asn1js.Integer({ value: serial++ });
  cert.subject = nameOf(input.cn, input.org);
  cert.issuer = input.issuer ? input.issuer.cert.subject : cert.subject;
  cert.notBefore.value = input.notBefore ?? new Date(Date.now() - DAY);
  cert.notAfter.value = input.notAfter ?? new Date(Date.now() + 365 * DAY);
  cert.extensions = [
    extension('2.5.29.19', true, new pkijs.BasicConstraints({ cA: !!input.ca }).toSchema()),
    extension('2.5.29.15', true, keyUsage(input.ca ? [5, 6] : input.tsa ? [0] : [0, 1])),
    ...(input.tsa ? [extension('2.5.29.37', true, new pkijs.ExtKeyUsage({ keyPurposes: [OID.timeStamping] }).toSchema())] : []),
  ];
  await cert.subjectPublicKeyInfo.importKey(input.keys.publicKey);
  await cert.sign((input.issuer?.keys ?? input.keys).privateKey, 'SHA-256');
  // Round-trip, so extensions are parsed as a reader would see them.
  return pkijs.Certificate.fromBER(cert.toSchema().toBER(false));
}

const derOf = (cert: pkijs.Certificate) => new Uint8Array(cert.toSchema().toBER(false));

export interface TestPki {
  rootDer: Uint8Array;
  sealChain: Uint8Array[];
  tsaDer: Uint8Array;
  signer: SealSigner;
  timestamper: Timestamper & { calls: Uint8Array[] };
}

/**
 * A root, a seal certificate and a timestamping authority; `clock` sets the time the TSA vouches for.
 * `sealKey: 'ec'` gives the seal an ECDSA P-256 key instead of RSA. `forgedTimestamps` has the seal
 * key sign the tokens while they still carry the TSA's certificate.
 */
export async function createTestPki(
  options: { org?: string; clock?: () => Date; sealNotAfter?: Date; sealKey?: 'rsa' | 'ec'; forgedTimestamps?: boolean } = {},
): Promise<TestPki> {
  const clock = options.clock ?? (() => new Date());
  const [rootKeys, sealKeys, tsaKeys] = await Promise.all([rsaKeys(), options.sealKey === 'ec' ? ecKeys() : rsaKeys(), rsaKeys()]);
  const root = await issue({ cn: 'Audit Anchor Test Root', keys: rootKeys, ca: true });
  const seal = await issue({ cn: `${options.org ?? 'Example Audit OOD'} (test seal)`, org: options.org ?? 'Example Audit OOD', keys: sealKeys, issuer: { cert: root, keys: rootKeys }, notAfter: options.sealNotAfter });
  const tsa = await issue({ cn: 'Audit Anchor Test TSA', keys: tsaKeys, issuer: { cert: root, keys: rootKeys }, tsa: true });
  // As a remote signing service does: it signs a digest it is handed, never the document.
  let signDigest: SealSigner['signDigest'];
  if (options.sealKey === 'ec') {
    const scalar = Buffer.from((await subtle.exportKey('jwk', sealKeys.privateKey)).d!, 'base64url');
    signDigest = async (digest) => p256.sign(digest, scalar).toDERRawBytes();
  } else {
    const sealPrivate = createPrivateKey({ key: Buffer.from(await subtle.exportKey('pkcs8', sealKeys.privateKey)), format: 'der', type: 'pkcs8' });
    signDigest = async (digest) => new Uint8Array(privateEncrypt({ key: sealPrivate, padding: constants.RSA_PKCS1_PADDING }, Buffer.concat([SHA256_DIGEST_INFO, digest])));
  }
  const signer: SealSigner = { certificates: async () => [derOf(seal), derOf(root)], signDigest };

  let tstSerial = 1;
  const calls: Uint8Array[] = [];
  const timestamper: TestPki['timestamper'] = {
    calls,
    async timestamp(digest) {
      calls.push(digest);
      const tstInfo = new pkijs.TSTInfo({
        version: 1,
        policy: '1.3.6.1.4.1.55555.1.1',
        messageImprint: new pkijs.MessageImprint({ hashAlgorithm: new pkijs.AlgorithmIdentifier({ algorithmId: OID.sha256 }), hashedMessage: new asn1js.OctetString({ valueHex: digest }) }),
        serialNumber: new asn1js.Integer({ value: tstSerial++ }),
        genTime: clock(),
      });
      const tstDer = new Uint8Array(tstInfo.toSchema().toBER(false));
      const [signingCert, signingKeys] = options.forgedTimestamps ? [seal, sealKeys] : [tsa, tsaKeys];
      const essCertIdV2 = new asn1js.Sequence({ value: [new asn1js.OctetString({ valueHex: sha256(derOf(signingCert)) })] });
      const signedData = new pkijs.SignedData({
        version: 3,
        encapContentInfo: new pkijs.EncapsulatedContentInfo({ eContentType: OID.tstInfo, eContent: new asn1js.OctetString({ valueHex: tstDer }) }),
        signerInfos: [
          new pkijs.SignerInfo({
            version: 1,
            sid: new pkijs.IssuerAndSerialNumber({ issuer: signingCert.issuer, serialNumber: signingCert.serialNumber }),
            signedAttrs: new pkijs.SignedAndUnsignedAttributes({
              type: 0,
              attributes: [
                new pkijs.Attribute({ type: OID.contentType, values: [new asn1js.ObjectIdentifier({ value: OID.tstInfo })] }),
                new pkijs.Attribute({ type: OID.messageDigest, values: [new asn1js.OctetString({ valueHex: sha256(tstDer) })] }),
                new pkijs.Attribute({ type: OID.signingCertificateV2, values: [new asn1js.Sequence({ value: [new asn1js.Sequence({ value: [essCertIdV2] })] })] }),
              ],
            }),
          }),
        ],
        certificates: options.forgedTimestamps ? [tsa, seal] : [tsa],
      });
      await signedData.sign(signingKeys.privateKey, 0, 'SHA-256');
      return new Uint8Array(new pkijs.ContentInfo({ contentType: OID.signedData, content: signedData.toSchema(true) }).toSchema().toBER(false));
    },
  };

  return { rootDer: derOf(root), sealChain: [derOf(seal), derOf(root)], tsaDer: derOf(tsa), signer, timestamper };
}

/** PEM, for handing a certificate to openssl. */
export const pemOf = (der: Uint8Array) => `-----BEGIN CERTIFICATE-----\n${Buffer.from(der).toString('base64').replace(/(.{64})/g, '$1\n')}\n-----END CERTIFICATE-----\n`;
