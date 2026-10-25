import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument, PDFName, PDFString } from '@cantoo/pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createPublicClient, createTestClient, createWalletClient, getAddress, http, hexToBytes, type Address, type Hex, type PublicClient, type TestClient } from 'viem';
import { foundry } from 'viem/chains';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createChainAdapter, type ChainAdapter } from '@/lib/chain/adapter';
import { deployRegistry, orgIdFor } from '@/lib/chain/deploy';
import type { Deployment } from '@/lib/chain/deployment';
import { ZERO_HASH } from '@/lib/chain/records';
import { stampPdf } from '@/lib/stamp';
import type { StampFields } from '@/lib/stamp-fields';
import {
  CannotVerify,
  docHashOf,
  dropRunningLines,
  locateOpinion,
  openRegistryView,
  opinionCommitmentOf,
  readDocument,
  verifyFile,
  type PdfjsLike,
  type Verdict,
  type VerifierConfig,
} from '@/lib/verify-core';
import { startAnvil, type AnvilHandle } from './anvil';

/**
 * The verifier end to end over a real registry: real fixture PDFs, real
 * stamped copies, and the two-endpoint view reading Anvil. Endpoint failures
 * use a second Anvil (same deployment, different state), one on another
 * chain, and a port nobody listens on.
 */

const fixture = (name: string) => new Uint8Array(fs.readFileSync(path.join(import.meta.dirname, '..', 'fixtures', 'pdf', name)));
const readPdf = (bytes: Uint8Array) => readDocument(pdfjs as unknown as PdfjsLike, bytes);
const SALT = `0x${'5e'.repeat(32)}` as Hex;

let anvil: AnvilHandle;
let other: AnvilHandle;
let publicClient: PublicClient;
let testClient: TestClient;
let deployment: Deployment;
let adapter: ChainAdapter;
let config: VerifierConfig;

async function deployOn(url: string): Promise<{ deployment: Deployment; adapter: ChainAdapter; publicClient: PublicClient; testClient: TestClient }> {
  const transport = http(url);
  const client = createPublicClient({ chain: foundry, transport, pollingInterval: 50 }) as PublicClient;
  // Anvil's unlocked dev accounts sign through JSON-RPC: no key appears in this repo.
  const [deployer, issuer] = (await createWalletClient({ chain: foundry, transport }).getAddresses()).map((a) => getAddress(a));
  const deployed = await deployRegistry({
    publicClient: client,
    walletClient: createWalletClient({ chain: foundry, transport, account: deployer }),
    issuer: { address: issuer, orgId: orgIdFor('Ledger Audit Ltd') },
  });
  return {
    deployment: deployed,
    adapter: createChainAdapter({ publicClient: client, walletClient: createWalletClient({ chain: foundry, transport, account: issuer }), deployment: deployed }),
    publicClient: client,
    testClient: createTestClient({ chain: foundry, mode: 'anvil', transport }),
  };
}

const verify = (bytes: Uint8Array, cfg: VerifierConfig = config) => verifyFile({ bytes, config: cfg, openView: () => openRegistryView(cfg), readPdf });

/** Anchors an original the way the app does: docHash of the file, commitment to the opinion it carries. */
async function anchorOriginal(bytes: Uint8Array, familyId: Hex, version = 1, parentId: Hex = ZERO_HASH) {
  const read = await readPdf(bytes);
  if (!read.ok) throw new Error(read.reason);
  const located = locateOpinion(dropRunningLines(read.doc.pageLines));
  if (located.status !== 'FOUND') throw new Error(located.reason);
  const sent = await adapter.anchor({
    familyId,
    version,
    parentId,
    docHash: docHashOf(bytes),
    manifestHash: docHashOf(new TextEncoder().encode(`manifest ${familyId} ${version}`)),
    opinionCommitment: opinionCommitmentOf({ salt: hexToBytes(SALT), type: located.type, text: located.text }),
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: sent.txHash });
  return { ...sent, blockNumber: Number(receipt.blockNumber), opinionType: located.type };
}

async function finalise() {
  await testClient.mine({ blocks: 3 });
}

function stampFor(original: Awaited<ReturnType<typeof anchorOriginal>>, familyId: Hex, version = 1): StampFields {
  return {
    stamp: 1,
    chainId: deployment.chainId,
    contract: getAddress(deployment.address),
    recordId: original.recordId,
    txHash: original.txHash,
    blockNumber: original.blockNumber,
    familyId,
    version,
    verifyUrl: 'https://anchor.example/verify',
    opinionType: original.opinionType,
    opinionSalt: SALT,
    norm: 1,
  };
}

/** A later incremental update that changes only the document title: the pages are untouched. */
async function retitled(bytes: Uint8Array): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { forIncrementalUpdate: true, updateMetadata: false });
  const info = doc.context.lookup(doc.context.trailerInfo.Info);
  if (!info || !('set' in info)) throw new Error('no Info dictionary');
  (info as { set(key: PDFName, value: PDFString): void }).set(PDFName.of('Title'), PDFString.of('Retitled'));
  return doc.commit();
}

beforeAll(async () => {
  [anvil, other] = await Promise.all([startAnvil(), startAnvil()]);
  ({ deployment, adapter, publicClient, testClient } = await deployOn(anvil.url));
  // The second node gets the same deployment (same deployer, same nonces), so
  // it passes the chain and bytecode checks, but none of the anchors below.
  const second = await deployOn(other.url);
  expect(second.deployment.address).toBe(deployment.address);
  config = { chainId: deployment.chainId, registry: deployment.address, runtimeBytecodeHash: deployment.runtimeBytecodeHash, rpcUrls: [anvil.url, anvil.url] };
}, 60_000);

afterAll(async () => {
  await Promise.all([anvil?.stop(), other?.stop()]);
});

describe('verifying real files against a real registry', () => {
  const family = `0x${'a1'.repeat(32)}` as Hex;
  let original: Uint8Array;
  let copy: Uint8Array;
  let anchored: Awaited<ReturnType<typeof anchorOriginal>>;

  beforeAll(async () => {
    original = fixture('en-unmodified.pdf');
    anchored = await anchorOriginal(original, family);
    copy = await stampPdf(original, stampFor(anchored, family));
    await adapter.anchorCopy(anchored.recordId, docHashOf(copy)).then((s) => publicClient.waitForTransactionReceipt({ hash: s.txHash }));
    await finalise();
  });

  it('calls the original and its stamped copy AUTHENTIC_LATEST, naming the anchoring transaction', async () => {
    const verdict = await verify(original);
    expect(verdict).toMatchObject({ kind: 'AUTHENTIC_LATEST', matched: { recordId: anchored.recordId, kind: 'ORIGINAL', txHash: anchored.txHash, blockNumber: anchored.blockNumber, orgId: orgIdFor('Ledger Audit Ltd') } });
    expect(await verify(copy)).toMatchObject({ kind: 'AUTHENTIC_LATEST', matched: { kind: 'DISTRIBUTION_COPY' }, original: { recordId: anchored.recordId } });
  });

  it('says a re-saved copy appears to carry the same opinion, without calling it authentic', async () => {
    expect(await verify(await retitled(copy))).toMatchObject({ kind: 'ALTERED_OPINION_APPEARS_UNCHANGED', claimed: { recordId: anchored.recordId } });
  });

  it('says the opinion changed when another report is passed off under this stamp', async () => {
    const swapped = await stampPdf(fixture('en-qualified.pdf'), stampFor(anchored, family));
    expect(await verify(swapped)).toMatchObject({ kind: 'ALTERED_OPINION_CHANGED', claimed: { recordId: anchored.recordId } });
  });

  it('calls an unstamped, unregistered report NOT_REGISTERED', async () => {
    expect(await verify(fixture('bg-adverse.pdf'))).toMatchObject({ kind: 'NOT_REGISTERED', note: 'NO_REFERENCE' });
  });

  it('does not count an anchor until its block is finalized', async () => {
    const pending = fixture('bg-disclaimer.pdf');
    await anchorOriginal(pending, `0x${'b2'.repeat(32)}` as Hex);
    expect(await verify(pending)).toMatchObject({ kind: 'NOT_REGISTERED', note: 'NO_REFERENCE' });
    await finalise();
    expect(await verify(pending)).toMatchObject({ kind: 'AUTHENTIC_LATEST' });
  });

  it('resolves a superseded version to the latest, and reports a revocation', async () => {
    const v2Bytes = fixture('en-qualified.pdf');
    const v2 = await anchorOriginal(v2Bytes, family, 2, anchored.recordId);
    await finalise();
    for (const bytes of [original, copy]) {
      expect(await verify(bytes)).toMatchObject({ kind: 'AUTHENTIC_SUPERSEDED', latest: { recordId: v2.recordId, version: 2 } });
    }
    const revoked = await adapter.revoke(v2.recordId, 2);
    await publicClient.waitForTransactionReceipt({ hash: revoked.txHash });
    await finalise();
    expect(await verify(v2Bytes)).toMatchObject({ kind: 'REVOKED', revoked: { recordId: v2.recordId, revokeReason: 2 } });
  });
});

describe('the two-endpoint registry view', () => {
  const refusal = async (cfg: VerifierConfig) =>
    openRegistryView(cfg).then(
      () => 'OPENED',
      (error: unknown) => (error instanceof CannotVerify ? error.reason : String(error)),
    );

  it('opens when both endpoints are on the chain and hold the contract, and reads at a finalized block', async () => {
    const view = await openRegistryView(config);
    const finalized = await publicClient.getBlock({ blockTag: 'finalized' });
    expect(view.blockNumber).toBe(finalized.number);
  });

  it('refuses an endpoint on another chain, even when the other is right', async () => {
    const wrongChain = await startAnvil({ chainId: 1337 });
    try {
      expect(await refusal({ ...config, rpcUrls: [anvil.url, wrongChain.url] })).toBe('WRONG_CHAIN');
      expect(await refusal({ ...config, chainId: 11155111 })).toBe('WRONG_CHAIN');
    } finally {
      await wrongChain.stop();
    }
  });

  it('refuses a registry address or bytecode that is not the deployment', async () => {
    const [, , stranger] = (await createWalletClient({ chain: foundry, transport: http(anvil.url) }).getAddresses()).map((a) => getAddress(a));
    expect(await refusal({ ...config, registry: stranger as Address })).toBe('WRONG_CONTRACT');
    expect(await refusal({ ...config, runtimeBytecodeHash: `0x${'00'.repeat(32)}` })).toBe('WRONG_CONTRACT');
  });

  it('refuses when an endpoint cannot be reached', async () => {
    expect(await refusal({ ...config, rpcUrls: [anvil.url, 'http://127.0.0.1:9'] })).toBe('RPC_UNREACHABLE');
  });

  it('turns two endpoints that answer differently into CANNOT_VERIFY, not a verdict', async () => {
    // Bring the second node's finalized block past the first's anchors, so both are read at a block where they differ.
    const latest = await publicClient.getBlockNumber();
    const secondTest = createTestClient({ chain: foundry, mode: 'anvil', transport: http(other.url) });
    const secondPublic = createPublicClient({ chain: foundry, transport: http(other.url) });
    await secondTest.mine({ blocks: Number(latest - (await secondPublic.getBlockNumber())) + 3 });
    const verdict: Verdict = await verify(fixture('en-unmodified.pdf'), { ...config, rpcUrls: [anvil.url, other.url] });
    expect(verdict).toEqual({ kind: 'CANNOT_VERIFY', reason: 'RPC_DISAGREE' });
  });
});
