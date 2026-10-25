import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument, PDFName, PDFString } from '@cantoo/pdf-lib';
import { createPublicClient, createTestClient, createWalletClient, getAddress, http, type Address, type Hex } from 'viem';
import { foundry } from 'viem/chains';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { orgIdFor } from '@/lib/chain/deploy';
import { stampPdf } from '@/lib/stamp';
import { CannotVerify, openRegistryView, verifyFile, type Verdict, type VerifierConfig } from '@/lib/verify-core';
import { startAnvil, type AnvilHandle } from './anvil';
import { anchorCopy, anchorOriginal, deployOn, finalise, ISSUER_ORG, readPdf, stampFor, type Anchored, type Registry } from './registry-harness';

/**
 * The verifier end to end over a real registry: real fixture PDFs, real
 * stamped copies, and the two-endpoint view reading Anvil. Endpoint failures
 * use a second Anvil (same deployment, different state), one on another
 * chain, and a port nobody listens on.
 */

const fixture = (name: string) => new Uint8Array(fs.readFileSync(path.join(import.meta.dirname, '..', 'fixtures', 'pdf', name)));

let anvil: AnvilHandle;
let other: AnvilHandle;
let registry: Registry;
let config: VerifierConfig;

const verify = (bytes: Uint8Array, cfg: VerifierConfig = config) => verifyFile({ bytes, config: cfg, openView: () => openRegistryView(cfg), readPdf });

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
  registry = await deployOn(anvil.url);
  const { deployment } = registry;
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
  let anchored: Anchored;

  beforeAll(async () => {
    original = fixture('en-unmodified.pdf');
    anchored = await anchorOriginal(registry, original, family);
    copy = await stampPdf(original, stampFor(registry, anchored));
    await anchorCopy(registry, anchored, copy);
    await finalise(registry);
  });

  it('calls the original and its stamped copy AUTHENTIC_LATEST, naming the anchoring transaction', async () => {
    const verdict = await verify(original);
    expect(verdict).toMatchObject({ kind: 'AUTHENTIC_LATEST', matched: { recordId: anchored.recordId, kind: 'ORIGINAL', txHash: anchored.txHash, blockNumber: anchored.blockNumber, orgId: orgIdFor(ISSUER_ORG) } });
    expect(await verify(copy)).toMatchObject({ kind: 'AUTHENTIC_LATEST', matched: { kind: 'DISTRIBUTION_COPY' }, original: { recordId: anchored.recordId } });
  });

  it('says a re-saved copy appears to carry the same opinion, without calling it authentic', async () => {
    expect(await verify(await retitled(copy))).toMatchObject({ kind: 'ALTERED_OPINION_APPEARS_UNCHANGED', claimed: { recordId: anchored.recordId } });
  });

  it('says the opinion changed when another report is passed off under this stamp', async () => {
    const swapped = await stampPdf(fixture('en-qualified.pdf'), stampFor(registry, anchored));
    expect(await verify(swapped)).toMatchObject({ kind: 'ALTERED_OPINION_CHANGED', claimed: { recordId: anchored.recordId } });
  });

  it('calls an unstamped, unregistered report NOT_REGISTERED', async () => {
    expect(await verify(fixture('bg-adverse.pdf'))).toMatchObject({ kind: 'NOT_REGISTERED', note: 'NO_REFERENCE' });
  });

  it('does not count an anchor until its block is finalized', async () => {
    const pending = fixture('bg-disclaimer.pdf');
    await anchorOriginal(registry, pending, `0x${'b2'.repeat(32)}` as Hex);
    expect(await verify(pending)).toMatchObject({ kind: 'NOT_REGISTERED', note: 'NO_REFERENCE' });
    await finalise(registry);
    expect(await verify(pending)).toMatchObject({ kind: 'AUTHENTIC_LATEST' });
  });

  it('resolves a superseded version to the latest, and reports a revocation', async () => {
    const v2Bytes = fixture('en-qualified.pdf');
    const v2 = await anchorOriginal(registry, v2Bytes, family, 2, anchored.recordId);
    await finalise(registry);
    for (const bytes of [original, copy]) {
      expect(await verify(bytes)).toMatchObject({ kind: 'AUTHENTIC_SUPERSEDED', latest: { recordId: v2.recordId, version: 2 } });
    }
    const revoked = await registry.adapter.revoke(v2.recordId, 2);
    await registry.publicClient.waitForTransactionReceipt({ hash: revoked.txHash });
    await finalise(registry);
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
    const finalized = await registry.publicClient.getBlock({ blockTag: 'finalized' });
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
    const latest = await registry.publicClient.getBlockNumber();
    const secondTest = createTestClient({ chain: foundry, mode: 'anvil', transport: http(other.url) });
    const secondPublic = createPublicClient({ chain: foundry, transport: http(other.url) });
    await secondTest.mine({ blocks: Number(latest - (await secondPublic.getBlockNumber())) + 3 });
    const verdict: Verdict = await verify(fixture('en-unmodified.pdf'), { ...config, rpcUrls: [anvil.url, other.url] });
    expect(verdict).toEqual({ kind: 'CANNOT_VERIFY', reason: 'RPC_DISAGREE' });
  });
});
