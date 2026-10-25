import { secp256k1 } from '@noble/curves/secp256k1';
import { parseGwei, verifyMessage, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { crc32c, createKmsAccount, KmsSignerError, parseDerSignature } from '@/lib/chain/kms-account';
import { fakeKms, KEY_NAME, type FakeKmsOptions } from '../helpers/fake-kms';

/**
 * The KMS issuer account (#62): it signs exactly as a local key would, from
 * the low-s form of whatever KMS returns, and refuses by name every response
 * it cannot vouch for.
 */

const key = secp256k1.utils.randomPrivateKey();
const local = privateKeyToAccount(`0x${Buffer.from(key).toString('hex')}` as Hex);
const kmsAccount = (options: FakeKmsOptions = {}) => createKmsAccount({ client: fakeKms(key, options), keyName: KEY_NAME });

const TX = {
  type: 'eip1559',
  chainId: 11155111,
  nonce: 7,
  to: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
  data: '0x1234',
  value: 0n,
  gas: 120_000n,
  maxFeePerGas: parseGwei('3'),
  maxPriorityFeePerGas: parseGwei('1'),
} as const;

const TYPED = {
  domain: { name: 'Audit Anchor', version: '1', chainId: 11155111 },
  types: { Report: [{ name: 'docHash', type: 'bytes32' }] },
  primaryType: 'Report',
  message: { docHash: `0x${'ab'.repeat(32)}` },
} as const;

async function codeOf(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(KmsSignerError);
  return (error as KmsSignerError).code;
}

describe('crc32c', () => {
  it('is CRC-32C (Castagnoli), as KMS computes it', () => {
    expect(crc32c(new TextEncoder().encode('123456789'))).toBe(0xe3069283);
    expect(crc32c(new Uint8Array())).toBe(0);
  });
});

describe('the KMS account', () => {
  it('has the address of the KMS key', async () => {
    expect((await kmsAccount()).address).toBe(local.address);
  });

  it.each([false, true])('signs a transaction, a message and typed data exactly as the key itself would (KMS returns high s: %s)', async (highS) => {
    const account = await kmsAccount({ highS });
    expect(await account.signTransaction(TX)).toBe(await local.signTransaction(TX));
    expect(await account.signMessage({ message: 'anchor' })).toBe(await local.signMessage({ message: 'anchor' }));
    expect(await account.signTypedData(TYPED)).toBe(await local.signTypedData(TYPED));
    expect(await verifyMessage({ address: local.address, message: 'anchor', signature: await account.signMessage({ message: 'anchor' }) })).toBe(true);
  });

  it('refuses, by name, a key it cannot use', async () => {
    await expect(codeOf(createKmsAccount({ client: fakeKms(key), keyName: 'projects/p/locations/l/keyRings/r/cryptoKeys/k' }))).resolves.toBe('KEY_NAME_INVALID');
    await expect(codeOf(kmsAccount({ tamper: 'algorithm' }))).resolves.toBe('NOT_SECP256K1');
    await expect(codeOf(kmsAccount({ tamper: 'curve' }))).resolves.toBe('NOT_SECP256K1');
    await expect(codeOf(kmsAccount({ tamper: 'pemCrc' }))).resolves.toBe('PUBLIC_KEY_CORRUPTED');
  });

  it.each([
    ['digestUnverified', 'DIGEST_CORRUPTED'],
    ['signatureCrc', 'SIGNATURE_CORRUPTED'],
    ['otherVersion', 'WRONG_KEY_VERSION'],
    ['garbage', 'SIGNATURE_UNREADABLE'],
    ['otherKey', 'RECOVERY_FAILED'],
  ] as const)('refuses a signature when KMS answers with %s: %s, and never returns one', async (tamper, code) => {
    const account = await kmsAccount({ tamper });
    await expect(codeOf(account.signTransaction(TX))).resolves.toBe(code);
    await expect(codeOf(account.signMessage({ message: 'anchor' }))).resolves.toBe(code);
  });
});

describe('reading a DER signature', () => {
  const der = (hex: string) => new Uint8Array(Buffer.from(hex, 'hex'));

  it('reads r and s', () => {
    expect(parseDerSignature(der('3006020101020102'))).toEqual({ r: 1n, s: 2n });
    // A leading zero is allowed only where the next byte has its top bit set.
    expect(parseDerSignature(der('300702020080020102'))).toEqual({ r: 0x80n, s: 2n });
  });

  it.each([
    ['not a sequence', '3106020101020102'],
    ['a length that is not the rest', '3007020101020102'],
    ['trailing bytes', '300602010102010200'],
    ['a negative integer', '3006020181020102'],
    ['a non-minimal integer', '300702020001020102'],
    ['a zero r', '3006020100020102'],
    ['an s at or above the curve order', `302602010102${'21'}00${'ff'.repeat(32)}`],
    ['nothing', ''],
  ])('refuses %s', (_, hex) => {
    expect(() => parseDerSignature(der(hex))).toThrow(KmsSignerError);
  });
});
