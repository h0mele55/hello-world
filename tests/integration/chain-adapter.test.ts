import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  getAddress,
  http,
  keccak256,
  toBytes,
  type Address,
  type Hex,
  type PublicClient,
  type TestClient,
} from 'viem';
import { foundry } from 'viem/chains';
import { createChainAdapter, type ChainAdapter } from '@/lib/chain/adapter';
import { deployRegistry, orgIdFor } from '@/lib/chain/deploy';
import type { Deployment } from '@/lib/chain/deployment';
import { recordIdFor, ZERO_HASH } from '@/lib/chain/records';
import { registryAbi } from '@/lib/chain/registry-artifact';
import { startAnvil, type AnvilHandle } from './anvil';

const h = (label: string): Hex => keccak256(toBytes(label));

let anvil: AnvilHandle;
let publicClient: PublicClient;
let testClient: TestClient;
let deployment: Deployment;
let issuerAddress: Address;
let strangerAddress: Address;
let adapter: ChainAdapter;

function adapterFor(account: Address, overrides: Partial<Deployment> = {}): ChainAdapter {
  const walletClient = createWalletClient({ chain: foundry, transport: http(anvil.url), account });
  return createChainAdapter({ publicClient, walletClient, deployment: { ...deployment, ...overrides } });
}

async function mine(blocks = 3) {
  await testClient.mine({ blocks });
}

/** Waits for the transaction to be mined. A send alone is not an anchor, and a
 * dependent write (v2 after v1, a copy after its original) must see it land. */
async function landed<T extends { txHash: Hex }>(pending: Promise<T>): Promise<T> {
  const sent = await pending;
  await publicClient.waitForTransactionReceipt({ hash: sent.txHash });
  return sent;
}

beforeAll(async () => {
  anvil = await startAnvil();
  const transport = http(anvil.url);
  publicClient = createPublicClient({ chain: foundry, transport }) as PublicClient;
  testClient = createTestClient({ chain: foundry, mode: 'anvil', transport });
  // Anvil's unlocked dev accounts sign through JSON-RPC: no key appears in this repo.
  const accounts = await createWalletClient({ chain: foundry, transport }).getAddresses();
  const [deployer, issuer, stranger] = accounts.map((a) => getAddress(a));
  issuerAddress = issuer;
  strangerAddress = stranger;
  deployment = await deployRegistry({
    publicClient,
    walletClient: createWalletClient({ chain: foundry, transport, account: deployer }),
    issuer: { address: issuer, orgId: orgIdFor('Ledger Audit Ltd') },
  });
  adapter = adapterFor(issuerAddress);
}, 30_000);

afterAll(async () => {
  await anvil?.stop();
});

describe('AuditReportRegistry through the chain adapter, on Anvil', () => {
  it('deploys the expected build and registers the issuer', async () => {
    await expect(adapter.assertDeployment()).resolves.toBeUndefined();
    const [orgId, active] = await publicClient.readContract({
      address: deployment.address,
      abi: registryAbi,
      functionName: 'issuers',
      args: [issuerAddress],
    });
    expect(orgId).toBe(orgIdFor('Ledger Audit Ltd'));
    expect(active).toBe(true);
  });

  it('anchors version 1, reaches finality, and reads it back by document and by family', async () => {
    const family = h('family:v1');
    const sent = await adapter.anchor({
      familyId: family,
      version: 1,
      parentId: ZERO_HASH,
      docHash: h('doc:v1'),
      manifestHash: h('manifest:v1'),
      opinionCommitment: h('opinion:v1'),
    });
    expect(sent.recordId).toBe(recordIdFor(31337, deployment.address, family, 1, 'ORIGINAL'));

    await mine();
    const final = await adapter.waitFinal(sent.txHash, { pollMs: 20, timeoutMs: 5_000 });
    expect(final.txHash).toBe(sent.txHash);

    const byDoc = await adapter.findByDocHash(h('doc:v1'));
    expect(byDoc).toMatchObject({
      recordId: sent.recordId,
      familyId: family,
      version: 1,
      kind: 'ORIGINAL',
      parentId: ZERO_HASH,
      issuer: issuerAddress,
      revoked: false,
      opinionCommitment: h('opinion:v1'),
    });
    expect(byDoc?.blockNumber).toBe(Number(final.blockNumber));
    expect((await adapter.latestOf(family))?.recordId).toBe(sent.recordId);
  });

  it('computes the same record ids as the contract', async () => {
    for (const [version, kind] of [[1, 0], [7, 1]] as const) {
      const onChain = await publicClient.readContract({
        address: deployment.address,
        abi: registryAbi,
        functionName: 'recordIdFor',
        args: [h('family:ids'), version, kind],
      });
      expect(recordIdFor(31337, deployment.address, h('family:ids'), version, kind === 0 ? 'ORIGINAL' : 'DISTRIBUTION_COPY')).toBe(onChain);
    }
  });

  it('supersedes v1 with v2, and refuses a stale v2 by name before broadcasting', async () => {
    const family = h('family:versions');
    const v1 = await landed(adapter.anchor({ familyId: family, version: 1, parentId: ZERO_HASH, docHash: h('versions:1'), manifestHash: h('m1'), opinionCommitment: h('o1') }));
    const v2 = await landed(adapter.anchor({ familyId: family, version: 2, parentId: v1.recordId, docHash: h('versions:2'), manifestHash: h('m2'), opinionCommitment: h('o2') }));
    expect((await adapter.latestOf(family))?.recordId).toBe(v2.recordId);

    const nonceBefore = await publicClient.getTransactionCount({ address: issuerAddress });
    await expect(
      adapter.anchor({ familyId: family, version: 2, parentId: v1.recordId, docHash: h('versions:2b'), manifestHash: h('m2b'), opinionCommitment: h('o2b') }),
    ).rejects.toMatchObject({ code: 'REGISTRY_REVERT', errorName: 'StaleParent' });
    expect(await publicClient.getTransactionCount({ address: issuerAddress })).toBe(nonceBefore);
  });

  it('anchors a distribution copy as a child of its original, then revokes it', async () => {
    const family = h('family:copy');
    const original = await landed(adapter.anchor({ familyId: family, version: 1, parentId: ZERO_HASH, docHash: h('copy:original'), manifestHash: h('cm'), opinionCommitment: h('co') }));
    const copy = await landed(adapter.anchorCopy(original.recordId, h('copy:stamped')));
    expect(copy.recordId).toBe(recordIdFor(31337, deployment.address, family, 1, 'DISTRIBUTION_COPY'));

    const stamped = await adapter.findByDocHash(h('copy:stamped'));
    expect(stamped).toMatchObject({ kind: 'DISTRIBUTION_COPY', parentId: original.recordId, opinionCommitment: h('co') });
    expect((await adapter.latestOf(family))?.recordId).toBe(original.recordId);

    const revoked = await adapter.revoke(copy.recordId, 1);
    await mine();
    await adapter.waitFinal(revoked.txHash, { pollMs: 20, timeoutMs: 5_000 });
    expect(await adapter.getRecord(copy.recordId)).toMatchObject({ revoked: true, revokeReason: 1 });

    await expect(adapter.revoke(copy.recordId, 2)).rejects.toMatchObject({ errorName: 'AlreadyRevoked' });
  });

  it('refuses a key that is not an issuer', async () => {
    await expect(
      adapterFor(strangerAddress).anchor({ familyId: h('family:stranger'), version: 1, parentId: ZERO_HASH, docHash: h('stranger'), manifestHash: h('sm'), opinionCommitment: h('so') }),
    ).rejects.toMatchObject({ errorName: 'NotIssuer' });
  });

  it('refuses to write to the wrong chain or the wrong contract, and sends nothing', async () => {
    const nonceBefore = await publicClient.getTransactionCount({ address: issuerAddress });
    const input = { familyId: h('family:guard'), version: 1, parentId: ZERO_HASH, docHash: h('guard'), manifestHash: h('gm'), opinionCommitment: h('go') };
    await expect(adapterFor(issuerAddress, { chainId: 11155111 }).anchor(input)).rejects.toMatchObject({ code: 'CHAIN_MISMATCH' });
    await expect(adapterFor(issuerAddress, { runtimeBytecodeHash: h('not-this-build') }).anchor(input)).rejects.toMatchObject({ code: 'BYTECODE_MISMATCH' });
    await expect(adapterFor(issuerAddress, { address: strangerAddress }).anchor(input)).rejects.toMatchObject({ code: 'BYTECODE_MISMATCH' });
    expect(await publicClient.getTransactionCount({ address: issuerAddress })).toBe(nonceBefore);
  });

  it('reports NOT_FINAL when the block never reaches finality', async () => {
    const sent = await adapter.anchor({ familyId: h('family:slow'), version: 1, parentId: ZERO_HASH, docHash: h('slow'), manifestHash: h('slm'), opinionCommitment: h('slo') });
    // No blocks are mined after this one, so `finalized` stays two blocks behind it.
    await expect(adapter.waitFinal(sent.txHash, { pollMs: 20, timeoutMs: 300 })).rejects.toMatchObject({ code: 'NOT_FINAL' });
  });

  it('reads an unknown document or family as null', async () => {
    expect(await adapter.findByDocHash(h('never-anchored'))).toBeNull();
    expect(await adapter.latestOf(h('family:never'))).toBeNull();
    expect(await adapter.getRecord(h('no-such-record'))).toBeNull();
  });
});
