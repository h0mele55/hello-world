import { getAddress, hashMessage, hashTypedData, keccak256, numberToHex, recoverAddress, serializeSignature, serializeTransaction, type Address, type Hex, type LocalAccount, type Signature } from 'viem';
import { publicKeyToAddress, toAccount } from 'viem/accounts';

/**
 * An issuer account whose key never leaves Google Cloud KMS (#62): an
 * EC_SIGN_SECP256K1_SHA256 key, ideally HSM-protected. KMS signs a 32-byte
 * digest as given, so the digest sent is Ethereum's keccak256 hash, in the
 * field KMS names sha256. What comes back is DER; Ethereum needs the low-s
 * form and a recovery bit, which KMS does not give, so the bit is found by
 * recovering the address both ways.
 *
 * Every response is checked: the key's algorithm and curve, the CRC32C
 * integrity fields KMS returns, the key version that signed, and that the
 * signature recovers to this key's address. Anything else is a named
 * KmsSignerError, never a signature.
 */

/** The two calls this needs, shaped like @google-cloud/kms's KeyManagementServiceClient so it can be passed as is. */
export interface KmsClient {
  getPublicKey(request: { name: string }): Promise<[{ pem?: string | null; algorithm?: unknown; name?: string | null; pemCrc32c?: Int64Value | null }, ...unknown[]]>;
  asymmetricSign(request: {
    name: string;
    digest: { sha256: Uint8Array };
    digestCrc32c: { value: number };
  }): Promise<[{ signature?: Uint8Array | string | null; signatureCrc32c?: Int64Value | null; verifiedDigestCrc32c?: boolean | null; name?: string | null }, ...unknown[]]>;
}

/** protobuf Int64Value: KMS's CRC32C fields arrive as a number, a string or a Long. */
type Int64Value = { value?: number | string | { toString(): string } | null };

export type KmsSignerErrorCode =
  | 'KEY_NAME_INVALID'
  | 'NOT_SECP256K1'
  | 'PUBLIC_KEY_UNREADABLE'
  | 'PUBLIC_KEY_CORRUPTED'
  | 'DIGEST_CORRUPTED'
  | 'SIGNATURE_CORRUPTED'
  | 'WRONG_KEY_VERSION'
  | 'SIGNATURE_UNREADABLE'
  | 'RECOVERY_FAILED';

export class KmsSignerError extends Error {
  constructor(
    readonly code: KmsSignerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'KmsSignerError';
  }
}

/** A key version, the only thing that signs: projects/…/locations/…/keyRings/…/cryptoKeys/…/cryptoKeyVersions/N. */
export const KMS_KEY_VERSION_NAME = /^projects\/[^/]+\/locations\/[^/]+\/keyRings\/[^/]+\/cryptoKeys\/[^/]+\/cryptoKeyVersions\/\d+$/;

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const HALF_N = SECP256K1_N >> 1n;
/** SubjectPublicKeyInfo for id-ecPublicKey on secp256k1, followed by an uncompressed point: always these 23 bytes, then 65. */
const SECP256K1_SPKI_PREFIX = '3056301006072a8648ce3d020106052b8104000a034200';

// ── CRC32C (Castagnoli), as KMS computes its integrity fields ──

const CRC32C_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32c(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC32C_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const int64 = (v: Int64Value | null | undefined): number | null => (v?.value === undefined || v.value === null ? null : Number(String(v.value)));
const bytesOf = (v: Uint8Array | string): Uint8Array => (typeof v === 'string' ? new Uint8Array(Buffer.from(v, 'base64')) : new Uint8Array(v));

// ── DER ──

/** The (r, s) of a DER ECDSA signature: SEQUENCE { INTEGER r, INTEGER s }, read strictly. */
export function parseDerSignature(der: Uint8Array): { r: bigint; s: bigint } {
  const fail = (): never => {
    throw new KmsSignerError('SIGNATURE_UNREADABLE', 'KMS returned a signature that is not a DER ECDSA signature');
  };
  let at = 0;
  const byte = () => (at < der.length ? der[at++] : fail());
  if (byte() !== 0x30) fail();
  const total = byte();
  if (total & 0x80 || total !== der.length - 2) fail();
  const integer = () => {
    if (byte() !== 0x02) fail();
    const length = byte();
    if (length === 0 || length > 33 || at + length > der.length) fail();
    const value = der.subarray(at, at + length);
    at += length;
    if (value[0] & 0x80) fail(); // negative
    if (length > 1 && value[0] === 0 && !(value[1] & 0x80)) fail(); // not minimal
    return BigInt(`0x${Buffer.from(value).toString('hex')}`);
  };
  const r = integer();
  const s = integer();
  if (at !== der.length || r === 0n || s === 0n || r >= SECP256K1_N || s >= SECP256K1_N) fail();
  return { r, s };
}

/** The address of a secp256k1 public key in PEM SubjectPublicKeyInfo form. */
export function addressOfPem(pem: string): Address {
  const body = pem.replace(/-----(BEGIN|END) PUBLIC KEY-----/g, '').replace(/\s+/g, '');
  const der = Buffer.from(body, 'base64').toString('hex');
  if (der.length !== (23 + 65) * 2 || !der.startsWith(SECP256K1_SPKI_PREFIX) || der.slice(46, 48) !== '04') {
    throw new KmsSignerError('NOT_SECP256K1', 'the KMS key is not an uncompressed secp256k1 public key');
  }
  return publicKeyToAddress(`0x${der.slice(46)}`);
}

export interface KmsAccountOptions {
  client: KmsClient;
  /** The key version that signs. */
  keyName: string;
}

/** The issuer account for a KMS key version: reads its public key once, then signs every hash through KMS. */
export async function createKmsAccount({ client, keyName }: KmsAccountOptions): Promise<LocalAccount> {
  if (!KMS_KEY_VERSION_NAME.test(keyName)) throw new KmsSignerError('KEY_NAME_INVALID', 'KMS_KEY_NAME must name a key version: projects/…/cryptoKeyVersions/N');
  const [publicKey] = await client.getPublicKey({ name: keyName });
  if (publicKey.algorithm !== 'EC_SIGN_SECP256K1_SHA256') throw new KmsSignerError('NOT_SECP256K1', `the KMS key's algorithm is ${String(publicKey.algorithm)}, not EC_SIGN_SECP256K1_SHA256`);
  if (!publicKey.pem) throw new KmsSignerError('PUBLIC_KEY_UNREADABLE', 'KMS returned no public key');
  const pemCrc = int64(publicKey.pemCrc32c);
  if (pemCrc !== null && pemCrc !== crc32c(new TextEncoder().encode(publicKey.pem))) throw new KmsSignerError('PUBLIC_KEY_CORRUPTED', 'the public key does not match its CRC32C');
  const address = addressOfPem(publicKey.pem);

  async function signHash(hash: Hex): Promise<Signature> {
    const digest = new Uint8Array(Buffer.from(hash.slice(2), 'hex'));
    const [response] = await client.asymmetricSign({ name: keyName, digest: { sha256: digest }, digestCrc32c: { value: crc32c(digest) } });
    if (response.verifiedDigestCrc32c !== true) throw new KmsSignerError('DIGEST_CORRUPTED', 'KMS did not confirm the digest it signed');
    if (response.name && response.name !== keyName) throw new KmsSignerError('WRONG_KEY_VERSION', 'KMS signed with another key version');
    if (!response.signature) throw new KmsSignerError('SIGNATURE_UNREADABLE', 'KMS returned no signature');
    const der = bytesOf(response.signature);
    if (int64(response.signatureCrc32c) !== crc32c(der)) throw new KmsSignerError('SIGNATURE_CORRUPTED', 'the signature does not match its CRC32C');

    const { r, s: rawS } = parseDerSignature(der);
    // Ethereum accepts only the low-s form of the two equivalent signatures.
    const s = rawS > HALF_N ? SECP256K1_N - rawS : rawS;
    const rHex = numberToHex(r, { size: 32 });
    const sHex = numberToHex(s, { size: 32 });
    for (const yParity of [0, 1] as const) {
      const recovered = await recoverAddress({ hash, signature: { r: rHex, s: sHex, yParity } });
      if (getAddress(recovered) === address) return { r: rHex, s: sHex, yParity, v: yParity ? 28n : 27n };
    }
    throw new KmsSignerError('RECOVERY_FAILED', 'the signature KMS returned does not recover to the key’s address');
  }

  return toAccount({
    address,
    async sign({ hash }) {
      return serializeSignature(await signHash(hash));
    },
    async signMessage({ message }) {
      return serializeSignature(await signHash(hashMessage(message)));
    },
    async signTypedData(typedData) {
      return serializeSignature(await signHash(hashTypedData(typedData)));
    },
    async signTransaction(transaction, options) {
      const serializer = options?.serializer ?? serializeTransaction;
      // As viem's own local accounts do: a blob transaction is signed without its sidecars.
      const signable = transaction.type === 'eip4844' ? { ...transaction, sidecars: false as const } : transaction;
      const signature = await signHash(keccak256(await serializer(signable)));
      return serializer(transaction, signature);
    },
  });
}
