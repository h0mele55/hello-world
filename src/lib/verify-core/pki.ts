import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { sha256 as sha256Of } from 'viem';
import { SealError } from '../eseal/types';

/**
 * What the seal's checks share (#70, #119): object identifiers, reading DER,
 * and pkijs's crypto engine. Isomorphic: WebCrypto in the browser and in Node.
 */

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
  // The certificate status a long-term seal carries (#119).
  sha1: '1.3.14.3.2.26',
  extKeyUsage: '2.5.29.37',
  crlDistributionPoints: '2.5.29.31',
  authorityInfoAccess: '1.3.6.1.5.5.7.1.1',
  ocspAccess: '1.3.6.1.5.5.7.48.1',
  basicOcspResponse: '1.3.6.1.5.5.7.48.1.1',
  ocspNoCheck: '1.3.6.1.5.5.7.48.1.5',
  ocspSigning: '1.3.6.1.5.5.7.3.9',
} as const;

/** pkijs finds WebCrypto by itself in a browser, but not in Node, where it is `globalThis.crypto`. */
export function ensureEngine() {
  if (pkijs.getEngine().crypto) return;
  const webcrypto = globalThis.crypto;
  if (!webcrypto?.subtle) throw new SealError('MALFORMED', 'no WebCrypto to check a seal with');
  pkijs.setEngine('webcrypto', new pkijs.CryptoEngine({ name: 'webcrypto', crypto: webcrypto }));
}

export const sha256 = (...parts: Uint8Array[]): Uint8Array => {
  if (parts.length === 1) return sha256Of(parts[0], 'bytes');
  const joined = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    joined.set(part, at);
    at += part.length;
  }
  return sha256Of(joined, 'bytes');
};
export const view = (bytes: Uint8Array) => new Uint8Array(bytes);
export const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, i) => byte === b[i]);
/** Bytes as one character each, in chunks: a call takes only so many arguments. */
export function ascii(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x2000) out += String.fromCharCode(...bytes.subarray(i, i + 0x2000));
  return out;
}

export function parse<T>(der: Uint8Array, read: (schema: asn1js.AsnType) => T, what: string): T {
  const asn = asn1js.fromBER(view(der));
  if (asn.offset === -1) throw new SealError('MALFORMED', `${what} is not DER`);
  try {
    return read(asn.result);
  } catch {
    throw new SealError('MALFORMED', `${what} is not what it should be`);
  }
}

export const parseCertificate = (der: Uint8Array) => parse(der, (schema) => new pkijs.Certificate({ schema }), 'a certificate');
