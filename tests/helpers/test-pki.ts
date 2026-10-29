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
 *
 * With `statusUrls` (#119) the seal's and the authority's certificates name an
 * OCSP responder and a CRL there, and `status` answers for them as a CA would,
 * or as a misbehaving one does (`status.behaviour`); serve it with
 * tests/helpers/fake-status-responder.ts. With `intermediate`, an
 * intermediate CA issues both, and names only a CRL for its own status.
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
const uri = (value: string) => new pkijs.GeneralName({ type: 6, value });

async function issue(input: {
  cn: string;
  org?: string;
  keys: KeyPair;
  issuer?: { cert: pkijs.Certificate; keys: KeyPair };
  ca?: boolean;
  tsa?: boolean;
  notBefore?: Date;
  notAfter?: Date;
  /** Where this certificate's status is kept (#119). */
  ocspUrl?: string;
  crlUrl?: string;
  /** A delegated OCSP responder's certificate, with id-pkix-ocsp-nocheck unless `noCheck` is false. */
  ocspResponder?: { noCheck: boolean };
}) {
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
    ...(input.ocspResponder ? [extension('2.5.29.37', false, new pkijs.ExtKeyUsage({ keyPurposes: [OID.ocspSigning] }).toSchema())] : []),
    ...(input.ocspResponder?.noCheck ? [extension(OID.ocspNoCheck, false, new asn1js.Null())] : []),
    ...(input.ocspUrl
      ? [extension(OID.authorityInfoAccess, false, new pkijs.InfoAccess({ accessDescriptions: [new pkijs.AccessDescription({ accessMethod: OID.ocspAccess, accessLocation: uri(input.ocspUrl) })] }).toSchema())]
      : []),
    ...(input.crlUrl
      ? [extension(OID.crlDistributionPoints, false, new pkijs.CRLDistributionPoints({ distributionPoints: [new pkijs.DistributionPoint({ distributionPoint: [uri(input.crlUrl)] })] }).toSchema())]
      : []),
  ];
  await cert.subjectPublicKeyInfo.importKey(input.keys.publicKey);
  await cert.sign((input.issuer?.keys ?? input.keys).privateKey, 'SHA-256');
  // Round-trip, so extensions are parsed as a reader would see them.
  return pkijs.Certificate.fromBER(cert.toSchema().toBER(false));
}

const derOf = (cert: pkijs.Certificate) => new Uint8Array(cert.toSchema().toBER(false));

/** How the PKI's status authority answers (#119); every field is optional, and the defaults are a well-run CA's. */
export interface StatusBehaviour {
  /** Who signs OCSP responses: the issuing CA, a responder it delegated to (with or without ocsp-nocheck), or a key nobody vouches for. */
  responder?: 'issuer' | 'delegated' | 'delegated-without-nocheck' | 'stranger';
  /** Who signs CRLs. */
  crlSigner?: 'issuer' | 'stranger';
  thisUpdate?: Date;
  /** null: no nextUpdate at all. */
  nextUpdate?: Date | null;
  /** What an unrevoked certificate is answered as. */
  certStatus?: 'good' | 'unknown';
  /** An OCSPResponseStatus other than 0, answered with no response at all. */
  responseStatus?: number;
}

export interface TestStatusAuthority {
  behaviour: StatusBehaviour;
  /** Revokes the seal's, the authority's or the intermediate's certificate. */
  revoke(which: 'seal' | 'tsa' | 'intermediate'): void;
  /** An OCSP response to a DER OCSPRequest. */
  ocsp(request: Uint8Array): Promise<Uint8Array>;
  /** The CRL of `root` or `intermediate`, or null for another name. */
  crl(name: string): Promise<Uint8Array | null>;
}

export interface TestPki {
  rootDer: Uint8Array;
  sealChain: Uint8Array[];
  tsaDer: Uint8Array;
  /** The intermediate CA's certificate, when there is one. */
  intermediateDer: Uint8Array | null;
  status: TestStatusAuthority;
  signer: SealSigner;
  timestamper: Timestamper & {
    calls: Uint8Array[];
    /** A token as an authority answering a request would make it: with the request's nonce and the policy asked for. */
    token(digest: Uint8Array, request?: { nonce?: asn1js.Integer; policy?: string }): Promise<Uint8Array>;
  };
}

/**
 * A root, a seal certificate and a timestamping authority; `clock` sets the time the TSA vouches for.
 * `sealKey: 'ec'` gives the seal an ECDSA P-256 key instead of RSA. `forgedTimestamps` has the seal
 * key sign the tokens while they still carry the TSA's certificate.
 */
export async function createTestPki(
  options: {
    org?: string;
    clock?: () => Date;
    sealNotAfter?: Date;
    sealKey?: 'rsa' | 'ec';
    forgedTimestamps?: boolean;
    /** The fake status responder's OCSP URL and CRL base (#119). */
    statusUrls?: { ocsp: string; crl: string };
    intermediate?: boolean;
  } = {},
): Promise<TestPki> {
  const clock = options.clock ?? (() => new Date());
  const [rootKeys, sealKeys, tsaKeys, intermediateKeys] = await Promise.all([rsaKeys(), options.sealKey === 'ec' ? ecKeys() : rsaKeys(), rsaKeys(), options.intermediate ? rsaKeys() : null]);
  const root = await issue({ cn: 'Audit Anchor Test Root', keys: rootKeys, ca: true });
  const urls = options.statusUrls;
  const intermediate = intermediateKeys
    ? await issue({ cn: 'Audit Anchor Test Issuing CA', keys: intermediateKeys, issuer: { cert: root, keys: rootKeys }, ca: true, crlUrl: urls && `${urls.crl}/root.crl` })
    : null;
  const ca = intermediate && intermediateKeys ? { cert: intermediate, keys: intermediateKeys, name: 'intermediate' } : { cert: root, keys: rootKeys, name: 'root' };
  const sources = urls ? { ocspUrl: urls.ocsp, crlUrl: `${urls.crl}/${ca.name}.crl` } : {};
  const seal = await issue({ cn: `${options.org ?? 'Example Audit OOD'} (test seal)`, org: options.org ?? 'Example Audit OOD', keys: sealKeys, issuer: ca, notAfter: options.sealNotAfter, ...sources });
  const tsa = await issue({ cn: 'Audit Anchor Test TSA', keys: tsaKeys, issuer: ca, tsa: true, ...sources });
  const chainAbove = intermediate ? [intermediate, root] : [root];
  // As a remote signing service does: it signs a digest it is handed, never the document.
  let signDigest: SealSigner['signDigest'];
  if (options.sealKey === 'ec') {
    const scalar = Buffer.from((await subtle.exportKey('jwk', sealKeys.privateKey)).d!, 'base64url');
    signDigest = async (digest) => p256.sign(digest, scalar).toDERRawBytes();
  } else {
    const sealPrivate = createPrivateKey({ key: Buffer.from(await subtle.exportKey('pkcs8', sealKeys.privateKey)), format: 'der', type: 'pkcs8' });
    signDigest = async (digest) => new Uint8Array(privateEncrypt({ key: sealPrivate, padding: constants.RSA_PKCS1_PADDING }, Buffer.concat([SHA256_DIGEST_INFO, digest])));
  }
  const signer: SealSigner = { certificates: async () => [derOf(seal), ...chainAbove.map(derOf)], signDigest };

  let tstSerial = 1;
  const calls: Uint8Array[] = [];
  const timestamper: TestPki['timestamper'] = {
    calls,
    timestamp: (digest) => timestamper.token(digest),
    async token(digest, request = {}) {
      calls.push(digest);
      const tstInfo = new pkijs.TSTInfo({
        version: 1,
        policy: request.policy ?? '1.3.6.1.4.1.55555.1.1',
        ...(request.nonce ? { nonce: request.nonce } : {}),
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
        certificates: options.forgedTimestamps ? [tsa, seal] : [tsa, ...(intermediate ? [intermediate] : [])],
      });
      await signedData.sign(signingKeys.privateKey, 0, 'SHA-256');
      return new Uint8Array(new pkijs.ContentInfo({ contentType: OID.signedData, content: signedData.toSchema(true) }).toSchema().toBER(false));
    },
  };

  const cas = [{ cert: root, keys: rootKeys, name: 'root' }, ...(intermediate && intermediateKeys ? [{ cert: intermediate, keys: intermediateKeys, name: 'intermediate' }] : [])];
  return {
    rootDer: derOf(root),
    sealChain: [derOf(seal), ...chainAbove.map(derOf)],
    tsaDer: derOf(tsa),
    intermediateDer: intermediate ? derOf(intermediate) : null,
    status: statusAuthority(cas, { seal, tsa, intermediate }),
    signer,
    timestamper,
  };
}

const hexOf = (bytes: ArrayBuffer | Uint8Array) => Buffer.from(new Uint8Array(bytes)).toString('hex');
const serialHex = (cert: pkijs.Certificate) => hexOf(cert.serialNumber.valueBlock.valueHexView);

/** A CA's status service, OCSP and CRL, answering as `behaviour` says (#119). */
function statusAuthority(cas: { cert: pkijs.Certificate; keys: KeyPair; name: string }[], certs: Record<'seal' | 'tsa' | 'intermediate', pkijs.Certificate | null>): TestStatusAuthority {
  const revoked = new Map<string, Date>();
  const delegates = new Map<string, Promise<{ cert: pkijs.Certificate; keys: KeyPair }>>();
  let stranger: Promise<{ cert: pkijs.Certificate; keys: KeyPair }> | null = null;
  const strangerOf = () =>
    (stranger ??= rsaKeys().then(async (keys) => ({ cert: await issue({ cn: 'Not The CA', keys, ca: true }), keys })));
  const delegateOf = (ca: (typeof cas)[number], noCheck: boolean) => {
    const key = `${ca.name}:${noCheck}`;
    if (!delegates.has(key)) delegates.set(key, rsaKeys().then(async (keys) => ({ cert: await issue({ cn: `${ca.name} OCSP responder`, keys, issuer: ca, ocspResponder: { noCheck } }), keys })));
    return delegates.get(key)!;
  };
  const digest = async (algorithm: string, data: ArrayBuffer | Uint8Array) => hexOf(await subtle.digest(algorithm, new Uint8Array(data)));

  const authority: TestStatusAuthority = {
    behaviour: {},
    revoke(which) {
      const cert = certs[which];
      if (!cert) throw new Error(`this PKI has no ${which} certificate`);
      revoked.set(serialHex(cert), new Date(Date.now() - 60_000));
    },
    async ocsp(requestDer) {
      const b = authority.behaviour;
      if (b.responseStatus) return new Uint8Array(new pkijs.OCSPResponse({ responseStatus: new asn1js.Enumerated({ value: b.responseStatus }) }).toSchema().toBER(false));
      const request = new pkijs.OCSPRequest({ schema: asn1js.fromBER(new Uint8Array(requestDer)).result });
      const certID = request.tbsRequest.requestList[0].reqCert;
      const algorithm = certID.hashAlgorithm.algorithmId === OID.sha1 ? 'SHA-1' : 'SHA-256';
      let ca: (typeof cas)[number] | undefined;
      for (const candidate of cas) {
        const nameHash = await digest(algorithm, candidate.cert.subject.toSchema().toBER(false));
        const keyHash = await digest(algorithm, candidate.cert.subjectPublicKeyInfo.subjectPublicKey.valueBlock.valueHexView);
        if (nameHash === hexOf(certID.issuerNameHash.valueBlock.valueHexView) && keyHash === hexOf(certID.issuerKeyHash.valueBlock.valueHexView)) ca = candidate;
      }
      if (!ca) return new Uint8Array(new pkijs.OCSPResponse({ responseStatus: new asn1js.Enumerated({ value: 6 }) }).toSchema().toBER(false));
      const when = revoked.get(hexOf(certID.serialNumber.valueBlock.valueHexView));
      const certStatus = when
        ? new asn1js.Constructed({ idBlock: { tagClass: 3, tagNumber: 1 }, value: [new asn1js.GeneralizedTime({ valueDate: when })] })
        : new asn1js.Primitive({ idBlock: { tagClass: 3, tagNumber: b.certStatus === 'unknown' ? 2 : 0 } });
      const now = Date.now();
      const single = new pkijs.SingleResponse({ certID, certStatus, thisUpdate: b.thisUpdate ?? new Date(now - 60_000) });
      if (b.nextUpdate !== null) single.nextUpdate = b.nextUpdate ?? new Date(now + DAY);
      const responder =
        b.responder === 'stranger'
          ? await strangerOf()
          : b.responder === 'delegated' || b.responder === 'delegated-without-nocheck'
            ? await delegateOf(ca, b.responder === 'delegated')
            : ca;
      const basic = new pkijs.BasicOCSPResponse();
      basic.tbsResponseData.responderID = responder.cert.subject;
      basic.tbsResponseData.producedAt = new Date(now);
      basic.tbsResponseData.responses.push(single);
      if (responder !== ca) basic.certs = [responder.cert];
      await basic.sign(responder.keys.privateKey, 'SHA-256');
      return new Uint8Array(
        new pkijs.OCSPResponse({
          responseStatus: new asn1js.Enumerated({ value: 0 }),
          responseBytes: new pkijs.ResponseBytes({ responseType: OID.basicOcspResponse, response: new asn1js.OctetString({ valueHex: basic.toSchema().toBER(false) }) }),
        })
          .toSchema()
          .toBER(false),
      );
    },
    async crl(name) {
      const ca = cas.find((c) => c.name === name);
      if (!ca) return null;
      const b = authority.behaviour;
      const signer = b.crlSigner === 'stranger' ? await strangerOf() : ca;
      const now = Date.now();
      const crl = new pkijs.CertificateRevocationList();
      crl.version = 1;
      crl.issuer = ca.cert.subject;
      crl.thisUpdate = new pkijs.Time({ type: 0, value: b.thisUpdate ?? new Date(now - 60_000) });
      if (b.nextUpdate !== null) crl.nextUpdate = new pkijs.Time({ type: 0, value: b.nextUpdate ?? new Date(now + DAY) });
      const listed = Object.values(certs).filter((c): c is pkijs.Certificate => !!c && c.issuer.isEqual(ca.cert.subject) && revoked.has(serialHex(c)));
      if (listed.length) {
        crl.revokedCertificates = listed.map((c) => new pkijs.RevokedCertificate({ userCertificate: c.serialNumber, revocationDate: new pkijs.Time({ type: 0, value: revoked.get(serialHex(c))! }) }));
      }
      await crl.sign(signer.keys.privateKey, 'SHA-256');
      return new Uint8Array(crl.toSchema(true).toBER(false));
    },
  };
  return authority;
}

/** PEM, for handing a certificate to openssl. */
export const pemOf = (der: Uint8Array) => `-----BEGIN CERTIFICATE-----\n${Buffer.from(der).toString('base64').replace(/(.{64})/g, '$1\n')}\n-----END CERTIFICATE-----\n`;
