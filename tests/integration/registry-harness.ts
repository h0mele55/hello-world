import { createPublicClient, createTestClient, createWalletClient, getAddress, hexToBytes, http, type Hex, type PublicClient, type TestClient } from 'viem';
import { foundry } from 'viem/chains';
import { createChainAdapter, type ChainAdapter } from '@/lib/chain/adapter';
import { deployRegistry, orgIdFor } from '@/lib/chain/deploy';
import type { Deployment } from '@/lib/chain/deployment';
import { ZERO_HASH } from '@/lib/chain/records';
import type { StampFields } from '@/lib/stamp-fields';
import { docHashOf, dropRunningLines, locateOpinion, opinionCommitmentOf, readDocument, type PdfjsLike } from '@/lib/verify-core';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

/**
 * A registry on a throwaway Anvil node, anchored to the way the app anchors:
 * docHash of the file, a commitment to the opinion it carries. Shared by the
 * verifier's integration test and the tamper suite.
 */

export const ISSUER_ORG = 'Ledger Audit Ltd';
export const SALT = `0x${'5e'.repeat(32)}` as Hex;
export const readPdf = (bytes: Uint8Array) => readDocument(pdfjs as unknown as PdfjsLike, bytes);

export interface Registry {
  deployment: Deployment;
  adapter: ChainAdapter;
  publicClient: PublicClient;
  testClient: TestClient;
}

export type Anchored = Awaited<ReturnType<typeof anchorOriginal>>;

/** Deploys a registry on an Anvil node. Revocation is immediate unless a delay is given (#95); the chain is Anvil's unless its id is given. */
export async function deployOn(url: string, options: { revocationDelaySeconds?: number; chainId?: number } = {}): Promise<Registry> {
  const chain = options.chainId ? { ...foundry, id: options.chainId } : foundry;
  const transport = http(url);
  const client = createPublicClient({ chain, transport, pollingInterval: 50 }) as PublicClient;
  // Anvil's unlocked dev accounts sign through JSON-RPC: no key appears in this repo.
  const [deployer, issuer] = (await createWalletClient({ chain, transport }).getAddresses()).map((a) => getAddress(a));
  const deployed = await deployRegistry({
    publicClient: client,
    walletClient: createWalletClient({ chain, transport, account: deployer }),
    issuer: { address: issuer, orgId: orgIdFor(ISSUER_ORG) },
    revocationDelaySeconds: options.revocationDelaySeconds,
  });
  return {
    deployment: deployed,
    adapter: createChainAdapter({ publicClient: client, walletClient: createWalletClient({ chain, transport, account: issuer }), deployment: deployed }),
    publicClient: client,
    testClient: createTestClient({ chain, mode: 'anvil', transport }),
  };
}

/** Anchors an original: docHash of the file, commitment to the opinion it carries, landed but not yet final. */
export async function anchorOriginal(registry: Registry, bytes: Uint8Array, familyId: Hex, version = 1, parentId: Hex = ZERO_HASH) {
  const read = await readPdf(bytes);
  if (!read.ok) throw new Error(read.reason);
  const located = locateOpinion(dropRunningLines(read.doc.pageLines));
  if (located.status !== 'FOUND') throw new Error(located.status === 'NOT_FOUND' ? located.reason : 'several reports');
  const sent = await registry.adapter.anchor({
    familyId,
    version,
    parentId,
    docHash: docHashOf(bytes),
    manifestHash: docHashOf(new TextEncoder().encode(`manifest ${familyId} ${version}`)),
    opinionCommitment: opinionCommitmentOf({ salt: hexToBytes(SALT), type: located.type, text: located.text }),
  });
  const receipt = await registry.publicClient.waitForTransactionReceipt({ hash: sent.txHash });
  return { ...sent, familyId, version, blockNumber: Number(receipt.blockNumber), opinionType: located.type };
}

/** Anchors a distribution copy of an original and waits for it to land. */
export async function anchorCopy(registry: Registry, original: Anchored, copy: Uint8Array) {
  const sent = await registry.adapter.anchorCopy(original.recordId, docHashOf(copy));
  await registry.publicClient.waitForTransactionReceipt({ hash: sent.txHash });
  return sent;
}

/** Mines past the latest block, so everything landed so far is finalized. */
export async function finalise(registry: Registry) {
  await registry.testClient.mine({ blocks: 3 });
}

/** The stamp the worker writes on an original's distribution copy. */
export function stampFor(registry: Registry, original: Anchored): StampFields {
  return {
    stamp: 1,
    chainId: registry.deployment.chainId,
    contract: getAddress(registry.deployment.address),
    recordId: original.recordId,
    txHash: original.txHash,
    blockNumber: original.blockNumber,
    familyId: original.familyId,
    version: original.version,
    verifyUrl: 'https://anchor.example/verify',
    opinionType: original.opinionType,
    opinionSalt: SALT,
    norm: 1,
  };
}
