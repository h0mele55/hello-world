import { describe, expect, it } from 'vitest';
import { BaseError, ContractFunctionRevertedError, encodeErrorResult, keccak256, toBytes } from 'viem';
import { toRegistryError } from '@/lib/chain/adapter';
import { orgIdFor } from '@/lib/chain/deploy';
import { parseDeployment } from '@/lib/chain/deployment';
import { ChainError } from '@/lib/chain/errors';
import { decodeRecord, revocationStateOf, ZERO_HASH, type RawRecord } from '@/lib/chain/records';
import { registryAbi, registryRuntimeBytecodeHash } from '@/lib/chain/registry-artifact';

const ADDRESS = '0x5FbDB2315678afecb367f032d93F642f64180aa3';

describe('parseDeployment', () => {
  const valid = { chainId: 11155111, address: ADDRESS, runtimeBytecodeHash: registryRuntimeBytecodeHash };

  it('accepts a record of this build', () => {
    expect(parseDeployment(valid, 'deployments/sepolia.json')).toEqual(valid);
  });

  it.each([
    ['null', null],
    ['missing chain id', { ...valid, chainId: undefined }],
    ['bad address', { ...valid, address: '0x123' }],
    ['short hash', { ...valid, runtimeBytecodeHash: '0x1234' }],
  ])('refuses %s as DEPLOYMENT_INVALID', (_label, value) => {
    expect(() => parseDeployment(value, 'x.json')).toThrow(expect.objectContaining({ code: 'DEPLOYMENT_INVALID' }));
  });

  it('refuses a deployment of a different build as DEPLOYMENT_STALE', () => {
    const other = { ...valid, runtimeBytecodeHash: keccak256(toBytes('older build')) };
    expect(() => parseDeployment(other, 'x.json')).toThrow(expect.objectContaining({ code: 'DEPLOYMENT_STALE' }));
  });
});

describe('decodeRecord', () => {
  const raw: RawRecord = {
    familyId: keccak256(toBytes('f')),
    docHash: keccak256(toBytes('d')),
    manifestHash: keccak256(toBytes('m')),
    opinionCommitment: keccak256(toBytes('o')),
    parentId: ZERO_HASH,
    issuer: ADDRESS,
    blockNumber: 7,
    version: 1,
    kind: 1,
    revoked: false,
    revokeReason: 0,
    revokeEffectiveAt: 0,
  };

  it('reads an all-zero struct as "no record"', () => {
    expect(decodeRecord(ZERO_HASH, { ...raw, docHash: ZERO_HASH })).toBeNull();
  });

  it('names the kind', () => {
    expect(decodeRecord(ZERO_HASH, raw)?.kind).toBe('DISTRIBUTION_COPY');
  });

  it('refuses a kind this code does not know', () => {
    expect(() => decodeRecord(ZERO_HASH, { ...raw, kind: 2 })).toThrow(expect.objectContaining({ code: 'UNKNOWN_KIND' }));
  });

  it('keeps when a revocation takes effect, and tells pending from in effect', () => {
    const pending = decodeRecord(ZERO_HASH, { ...raw, revokeReason: 2, revokeEffectiveAt: 1_800_000_000 })!;
    expect(pending.revokeEffectiveAt).toBe(1_800_000_000);
    expect(revocationStateOf(pending)).toBe('PENDING');
    expect(revocationStateOf({ ...pending, revoked: true })).toBe('IN_EFFECT');
    expect(revocationStateOf(decodeRecord(ZERO_HASH, raw)!)).toBe('NONE');
  });
});

describe('toRegistryError', () => {
  it('names the contract custom error', () => {
    const data = encodeErrorResult({ abi: registryAbi, errorName: 'StaleParent', args: [ZERO_HASH, ZERO_HASH] });
    const reverted = new ContractFunctionRevertedError({ abi: registryAbi, data, functionName: 'anchor' });
    const wrapped = new BaseError('call failed', { cause: reverted });
    expect(toRegistryError(wrapped)).toMatchObject({ code: 'REGISTRY_REVERT', errorName: 'StaleParent' });
  });

  it('passes other errors through unchanged', () => {
    const own = new ChainError('X', 'x');
    const other = new Error('network down');
    expect(toRegistryError(own)).toBe(own);
    expect(toRegistryError(other)).toBe(other);
  });
});

describe('orgIdFor', () => {
  it('is keccak256 of the organisation name', () => {
    expect(orgIdFor('Ledger Audit Ltd')).toBe(keccak256(toBytes('Ledger Audit Ltd')));
  });
});
