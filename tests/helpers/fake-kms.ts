import { generateKeyPairSync } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1';
import { crc32c, type KmsClient } from '@/lib/chain/kms-account';

/**
 * A stand-in for Cloud KMS backed by a secp256k1 key held in memory: it
 * answers getPublicKey and asymmetricSign the way KMS does (PEM, DER, CRC32C
 * fields, the digest signed as given). `tamper` makes it misbehave in the
 * ways the real one could, one at a time.
 */

const SPKI_PREFIX = '3056301006072a8648ce3d020106052b8104000a034200';
/** A P-256 key's SubjectPublicKeyInfo: the wrong curve, as a key made with the wrong algorithm would have. */
export const P256_PEM = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ type: 'spki', format: 'pem' }).toString();

export interface FakeKmsOptions {
  /** Return the high-s twin of every signature, as KMS may. */
  highS?: boolean;
  tamper?: 'algorithm' | 'curve' | 'pemCrc' | 'digestUnverified' | 'signatureCrc' | 'otherVersion' | 'garbage' | 'otherKey';
}

export function fakeKms(privateKey: Uint8Array, options: FakeKmsOptions = {}): KmsClient & { signed: number } {
  const point = Buffer.from(secp256k1.getPublicKey(privateKey, false)).toString('hex');
  const pem = options.tamper === 'curve' ? P256_PEM : `-----BEGIN PUBLIC KEY-----\n${Buffer.from(SPKI_PREFIX + point, 'hex').toString('base64')}\n-----END PUBLIC KEY-----\n`;
  const otherKey = secp256k1.utils.randomPrivateKey();
  const fake = {
    signed: 0,
    async getPublicKey({ name }: { name: string }) {
      const crc = crc32c(new TextEncoder().encode(pem));
      return [
        {
          name,
          pem,
          algorithm: options.tamper === 'algorithm' ? 'EC_SIGN_P256_SHA256' : 'EC_SIGN_SECP256K1_SHA256',
          // KMS sends 64-bit integers as strings.
          pemCrc32c: { value: String(options.tamper === 'pemCrc' ? crc ^ 1 : crc) },
        },
      ] as [{ name: string; pem: string; algorithm: string; pemCrc32c: { value: string } }];
    },
    async asymmetricSign({ name, digest, digestCrc32c }: { name: string; digest: { sha256: Uint8Array }; digestCrc32c: { value: number } }) {
      fake.signed += 1;
      const signature = secp256k1.sign(digest.sha256, options.tamper === 'otherKey' ? otherKey : privateKey);
      const s = options.highS ? secp256k1.CURVE.n - signature.s : signature.s;
      let der: Uint8Array = new secp256k1.Signature(signature.r, s).toDERRawBytes();
      if (options.tamper === 'garbage') der = new Uint8Array([0x30, 0x03, 0x02, 0x01, 0x00]);
      const crc = crc32c(der);
      return [
        {
          name: options.tamper === 'otherVersion' ? name.replace(/\d+$/, '99') : name,
          signature: der,
          signatureCrc32c: { value: String(options.tamper === 'signatureCrc' ? crc ^ 1 : crc) },
          verifiedDigestCrc32c: options.tamper === 'digestUnverified' ? false : crc32c(digest.sha256) === digestCrc32c.value,
        },
      ] as [{ name: string; signature: Uint8Array; signatureCrc32c: { value: string }; verifiedDigestCrc32c: boolean }];
    },
  };
  return fake;
}

export const KEY_NAME = 'projects/p/locations/europe-west1/keyRings/anchor/cryptoKeys/issuer/cryptoKeyVersions/1';
