import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createPublicClient, createWalletClient, getAddress, http, type Address, type Hex, type PublicClient } from 'viem';
import { foundry } from 'viem/chains';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { orgIdFor } from '@/lib/chain/deploy';
import { buildReanchorArchive } from '@/lib/chain/reanchor-build';
import { registryAbi } from '@/lib/chain/registry-artifact';
import { stampPdf } from '@/lib/stamp';
import { CannotVerify, checkReanchorSet, findRecordedRoot, openRegistryView, verifyFile, verifyWithReanchors, type CheckedSet, type Verdict, type VerifierConfig } from '@/lib/verify-core';
import { leafOf, merkleTree, rootFromProof, type ReanchorArchive, type ReanchorProof } from '@/lib/verify-core/reanchor';
import { startAnvil, type AnvilHandle } from './anvil';
import { anchorCopy, anchorOriginal, deployOn, finalise, ISSUER_ORG, readPdf, stampFor, type Registry } from './registry-harness';

/**
 * The re-anchoring rehearsal (#65), on two Anvil chains: a registry standing
 * in for Sepolia (chain 11155111) holds a family with two versions and a copy,
 * a revoked report, and a report with a copy; scripts/reanchor.ts archives it,
 * the owner records the root on the other chain's registry, and then, with the
 * first chain shut down, every record proves against the root and every file
 * gets the verdict it got while that chain was up.
 */

const SEPOLIA = 11155111;
const DELAY = 3600;
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const run = promisify(execFile);
const fixture = (name: string) => new Uint8Array(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'pdf', name)));
const family = (n: number) => `0x${n.toString(16).padStart(2, '0').repeat(32)}` as Hex;

let sourceNode: AnvilHandle;
let targetNode: AnvilHandle;
let source: Registry;
let target: Registry;
let sourceConfig: VerifierConfig;
let targetConfig: VerifierConfig;
let owner: Address;
let work: string;
let sourceFile: string;
let targetFile: string;
const files: Record<string, Uint8Array> = {};
/** What each file got from the source chain while it was up. */
const direct: Record<string, Verdict> = {};
let archive: ReanchorArchive;
let proofs: ReanchorProof[];
let set: CheckedSet;

const clients = (url: string, chainId: number) => {
  const chain = { ...foundry, id: chainId };
  return [createPublicClient({ chain, transport: http(url) }), createPublicClient({ chain, transport: http(url) })] as [PublicClient, PublicClient];
};

async function recordRoot(entry: { root: Hex; count: number }, from: Address = owner) {
  const call = {
    address: target.deployment.address,
    abi: registryAbi,
    functionName: 'recordReanchorRoot',
    args: [entry.root, BigInt(archive.source.chainId), archive.source.registry, archive.source.block, entry.count],
  } as const;
  // Simulated first, as owner-call does: Anvil would mine a refused call as a reverted transaction.
  await target.publicClient.simulateContract({ ...call, account: from });
  const wallet = createWalletClient({ chain: foundry, transport: http(targetNode.url), account: from });
  await target.publicClient.waitForTransactionReceipt({ hash: await wallet.writeContract(call) });
  await finalise(target);
}

const reason = (error: unknown) => (error instanceof CannotVerify ? error.reason : String(error));
const throughSets = (bytes: Uint8Array, sets: CheckedSet[]) => verifyWithReanchors({ bytes, config: targetConfig, openView: () => openRegistryView(targetConfig), readPdf, sets });

beforeAll(async () => {
  [sourceNode, targetNode] = await Promise.all([startAnvil({ chainId: SEPOLIA }), startAnvil()]);
  [source, target] = await Promise.all([deployOn(sourceNode.url, { chainId: SEPOLIA, revocationDelaySeconds: DELAY }), deployOn(targetNode.url)]);
  owner = getAddress((await createWalletClient({ chain: foundry, transport: http(targetNode.url) }).getAddresses())[0]);

  const a1 = await anchorOriginal(source, fixture('en-unmodified.pdf'), family(0xa1));
  files['A v1 copy'] = await stampPdf(fixture('en-unmodified.pdf'), stampFor(source, a1));
  await anchorCopy(source, a1, files['A v1 copy']);
  await anchorOriginal(source, fixture('en-qualified.pdf'), family(0xa1), 2, a1.recordId);
  const b1 = await anchorOriginal(source, fixture('en-adverse.pdf'), family(0xb1));
  await source.publicClient.waitForTransactionReceipt({ hash: (await source.adapter.revoke(b1.recordId, 2)).txHash });
  const c1 = await anchorOriginal(source, fixture('bg-unmodified.pdf'), family(0xc1));
  files['C v1 copy'] = await stampPdf(fixture('bg-unmodified.pdf'), stampFor(source, c1));
  await anchorCopy(source, c1, files['C v1 copy']);
  // The verifier reads the target registry at its finalized block, so its deployment must be final too.
  await Promise.all([finalise(source), finalise(target)]);
  Object.assign(files, {
    'A v1': fixture('en-unmodified.pdf'),
    'A v2': fixture('en-qualified.pdf'),
    'B v1, revoked': fixture('en-adverse.pdf'),
    'C v1': fixture('bg-unmodified.pdf'),
    'C v1 copy, bytes appended': new Uint8Array([...files['C v1 copy'], ...new TextEncoder().encode('\n%appended\n')]),
  });

  const config = (r: Registry, url: string): VerifierConfig => ({ chainId: r.deployment.chainId, registry: r.deployment.address, runtimeBytecodeHash: r.deployment.runtimeBytecodeHash, rpcUrls: [url, url] });
  sourceConfig = config(source, sourceNode.url);
  targetConfig = config(target, targetNode.url);
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'reanchor-'));
  sourceFile = path.join(work, 'sepolia.json');
  targetFile = path.join(work, 'local.json');
  fs.writeFileSync(sourceFile, JSON.stringify({ network: 'sepolia', ...source.deployment, issuer: { orgId: orgIdFor(ISSUER_ORG), orgName: ISSUER_ORG } }));
  fs.writeFileSync(targetFile, JSON.stringify({ network: 'local', ...target.deployment, owner, issuer: { orgId: orgIdFor(ISSUER_ORG), orgName: ISSUER_ORG } }));
}, 120_000);

afterAll(async () => {
  await Promise.all([sourceNode?.stop(), targetNode?.stop()]);
});

describe('re-anchoring a registry whose chain is shut down (#65)', () => {
  const build = () => buildReanchorArchive({ clients: clients(sourceNode.url, SEPOLIA), source: { ...source.deployment, deployBlock: 0 }, target: { chainId: target.deployment.chainId, registry: target.deployment.address }, issuerNames: [ISSUER_ORG] });

  it('refuses to archive while a revocation still waits out the delay', async () => {
    await expect(build()).rejects.toMatchObject({ code: 'REVOCATION_PENDING' });
    await source.testClient.increaseTime({ seconds: DELAY + 1 });
    await source.testClient.mine({ blocks: 1 });
    await finalise(source);
  });

  it('archives every record at one finalized block, with a proof for each', async () => {
    for (const [name, bytes] of Object.entries(files)) direct[name] = await verifyFile({ bytes, config: sourceConfig, openView: () => openRegistryView(sourceConfig), readPdf });
    expect(Object.fromEntries(Object.entries(direct).map(([name, v]) => [name, v.kind]))).toEqual({
      'A v1': 'AUTHENTIC_SUPERSEDED',
      'A v1 copy': 'AUTHENTIC_SUPERSEDED',
      'A v2': 'AUTHENTIC_LATEST',
      'B v1, revoked': 'REVOKED',
      'C v1': 'AUTHENTIC_LATEST',
      'C v1 copy': 'AUTHENTIC_LATEST',
      'C v1 copy, bytes appended': 'ALTERED_OPINION_APPEARS_UNCHANGED',
    });

    ({ archive, proofs } = await build());
    expect(archive.records).toHaveLength(6);
    expect(archive.issuers).toEqual({ [orgIdFor(ISSUER_ORG).toLowerCase()]: ISSUER_ORG });
    set = checkReanchorSet(JSON.parse(JSON.stringify(archive)));
    expect(set).toMatchObject({ complete: true, count: 6, root: archive.root });
    expect(proofs).toHaveLength(6);
    for (const proof of proofs) {
      const checked = checkReanchorSet(JSON.parse(JSON.stringify(proof)));
      expect(checked.root).toBe(archive.root);
      // The record, its original if it is a copy, and its family's latest: all a verdict needs.
      const own = proof.records[0].record;
      expect(proof.records.map((r) => r.record.recordId)).toEqual([...new Set([own.recordId, own.familyLatest, ...(own.kind === 'DISTRIBUTION_COPY' ? [own.parentId] : [])])]);
    }
  });

  it('builds a tree whose every leaf proves against its root, and no altered leaf does', () => {
    const leaves = archive.records.map((r) => leafOf(archive.source, r));
    const tree = merkleTree(leaves);
    expect(tree.root).toBe(archive.root);
    for (const leaf of leaves) expect(rootFromProof(leaf, tree.proof(leaf))).toBe(tree.root);
    const altered = { ...archive.records[0], revoked: !archive.records[0].revoked };
    expect(rootFromProof(leafOf(archive.source, altered), tree.proof(leaves[0]))).not.toBe(tree.root);
    // Another registry's record, field for field the same, is another leaf.
    expect(leafOf({ ...archive.source, chainId: 1 }, archive.records[0])).not.toBe(leaves[0]);
  });

  it('refuses an archive or a proof that does not hold together', () => {
    const tampered = (edit: (a: ReanchorArchive) => void) => {
      const copy = JSON.parse(JSON.stringify(archive)) as ReanchorArchive;
      edit(copy);
      try {
        checkReanchorSet(copy);
        return 'ACCEPTED';
      } catch (error) {
        return reason(error);
      }
    };
    expect(tampered((a) => (a.records[1].revoked = !a.records[1].revoked))).toBe('REANCHOR_PROOF_INVALID');
    expect(tampered((a) => a.records.pop())).toBe('REANCHOR_PROOF_INVALID');
    expect(tampered((a) => (a.records[0].version = 7))).toBe('REANCHOR_PROOF_INVALID');
    expect(tampered((a) => (a.issuers[orgIdFor(ISSUER_ORG).toLowerCase()] = 'Another Firm Ltd'))).toBe('REANCHOR_PROOF_INVALID');
    expect(tampered((a) => (a.target = { chainId: a.source.chainId, registry: a.source.registry }))).toBe('REANCHOR_PROOF_INVALID');
    expect(tampered((a) => (a.format = 'something-else' as never))).toBe('REANCHOR_PROOF_INVALID');
    const proof = JSON.parse(JSON.stringify(proofs[0])) as ReanchorProof;
    proof.records[0].proof.reverse().push(archive.root);
    expect(() => checkReanchorSet(proof)).toThrow(/does not lead to the root/);
  });

  it('accepts nothing until the owner records the root, and only the owner can', async () => {
    await expect(findRecordedRoot(set, targetConfig)).rejects.toMatchObject({ reason: 'REANCHOR_ROOT_NOT_RECORDED' });
    const issuerKey = getAddress((await createWalletClient({ chain: foundry, transport: http(targetNode.url) }).getAddresses())[1]);
    await expect(recordRoot({ root: archive.root, count: 6 }, issuerKey)).rejects.toThrow(/NotOwner/);
    // A root recorded for the wrong count is not this archive's root.
    await recordRoot({ root: archive.root, count: 5 });
    await expect(findRecordedRoot(set, targetConfig)).rejects.toMatchObject({ reason: 'REANCHOR_ROOT_NOT_RECORDED' });
  });

  it('through the scripts: build, the owner’s call, and every proof checked against the root', async () => {
    const out = path.join(work, 'archive-dir');
    const env = { PATH: process.env.PATH, SEPOLIA_RPC_URL: sourceNode.url, SEPOLIA_RPC_URL_2: sourceNode.url.replace('127.0.0.1', 'localhost'), LOCAL_RPC_URL: targetNode.url } as unknown as NodeJS.ProcessEnv;
    const tsx = path.join(ROOT, 'node_modules', '.bin', 'tsx');
    const built = JSON.parse((await run(tsx, ['scripts/reanchor.ts', 'build', 'sepolia', 'local', '--out', out, '--source-deployment', sourceFile, '--target-deployment', targetFile], { cwd: ROOT, env })).stdout);
    expect(built).toMatchObject({ root: archive.root, records: 6, sourceBlock: archive.source.block });
    expect(fs.readdirSync(path.join(out, 'proofs'))).toHaveLength(6);
    // An archive is never written over.
    await expect(run(tsx, ['scripts/reanchor.ts', 'build', 'sepolia', 'local', '--out', out, '--source-deployment', sourceFile, '--target-deployment', targetFile], { cwd: ROOT, env })).rejects.toMatchObject({ code: 2 });

    // Before the root: every proof fails, and the check says so.
    await expect(run(tsx, ['scripts/reanchor.ts', 'check', out, 'local', '--target-deployment', targetFile], { cwd: ROOT, env })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('REANCHOR_ROOT_NOT_RECORDED') });

    const printed = JSON.parse((await run(tsx, ['scripts/owner-call.ts', 'local', 'record-reanchor-root', path.join(out, 'archive.json'), '--deployment', targetFile], { cwd: ROOT, env })).stdout);
    expect(printed.message).toMatch(/not sent/);
    expect(printed.transaction.from).toBe(owner);
    const wallet = createWalletClient({ chain: foundry, transport: http(targetNode.url), account: owner });
    await target.publicClient.waitForTransactionReceipt({ hash: await wallet.sendTransaction({ to: printed.transaction.to, data: printed.transaction.data, chain: foundry }) });
    await finalise(target);

    const checked = JSON.parse((await run(tsx, ['scripts/reanchor.ts', 'check', out, 'local', '--target-deployment', targetFile], { cwd: ROOT, env })).stdout);
    expect(checked).toMatchObject({ index: 1, root: archive.root, records: 6, proofs: 6, failures: 0 });
    expect(await findRecordedRoot(set, targetConfig)).toMatchObject({ index: 1, count: 6, sourceBlock: archive.source.block });

    // A proof edited after the build fails the check, by name.
    const first = fs.readdirSync(path.join(out, 'proofs'))[0];
    const edited = JSON.parse(fs.readFileSync(path.join(out, 'proofs', first), 'utf8')) as ReanchorProof;
    edited.records[0].record.revokeReason = 9;
    fs.writeFileSync(path.join(out, 'proofs', first), JSON.stringify(edited));
    await expect(run(tsx, ['scripts/reanchor.ts', 'check', out, 'local', '--target-deployment', targetFile], { cwd: ROOT, env })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining(first) });
  }, 120_000);

  it('once the chain is shut down, every file gets the verdict it got while it was up', async () => {
    await sourceNode.stop();
    await expect(verifyFile({ bytes: files['A v2'], config: sourceConfig, openView: () => openRegistryView(sourceConfig), readPdf })).resolves.toMatchObject({ kind: 'CANNOT_VERIFY', reason: 'RPC_UNREACHABLE' });

    for (const [name, bytes] of Object.entries(files)) {
      const { verdict, reanchored } = await throughSets(bytes, [set]);
      expect(verdict, name).toEqual({ ...direct[name], asOfBlock: archive.source.block });
      expect(reanchored, name).toMatchObject({ index: 1, root: archive.root, sourceChainId: SEPOLIA, targetChainId: target.deployment.chainId, issuers: archive.issuers });
    }
    // A file neither registry knows stays NOT_REGISTERED, from the verifier's own registry.
    const unknown = await throughSets(fixture('en-disclaimer.pdf'), [set]);
    expect(unknown).toMatchObject({ verdict: { kind: 'NOT_REGISTERED', note: 'NO_REFERENCE' }, reanchored: null });
  });

  it('a single record’s proof is enough for its file, and says so when asked about another', async () => {
    const proofOf = (name: string) => {
      const docHash = direct[name].kind === 'ALTERED_OPINION_APPEARS_UNCHANGED' ? null : (direct[name] as { matched: { docHash: Hex } }).matched.docHash;
      return checkReanchorSet(proofs.find((p) => p.records[0].record.docHash === docHash));
    };
    for (const name of ['A v1', 'A v1 copy', 'A v2', 'B v1, revoked', 'C v1 copy']) {
      const { verdict } = await throughSets(files[name], [proofOf(name)]);
      expect(verdict, name).toEqual({ ...direct[name], asOfBlock: archive.source.block });
    }
    // The appended copy names C v1's copy; A v2's proof does not hold it, and cannot say there is none.
    const { verdict } = await throughSets(files['C v1 copy, bytes appended'], [proofOf('A v2')]);
    expect(verdict).toEqual({ kind: 'CANNOT_VERIFY', reason: 'REANCHOR_NOT_COVERED' });
    // The whole archive, given too, answers it.
    expect((await throughSets(files['C v1 copy, bytes appended'], [proofOf('A v2'), set])).verdict.kind).toBe('ALTERED_OPINION_APPEARS_UNCHANGED');
  });

  it('the CLI verifies through an archive or a proof', async () => {
    execFileSync(path.join(ROOT, 'node_modules', '.bin', 'tsx'), ['scripts/build-verifier.ts', '--cli-only'], { cwd: ROOT, stdio: 'pipe' });
    const pdf = path.join(work, 'report.pdf');
    fs.writeFileSync(pdf, files['C v1 copy']);
    const proofFile = path.join(work, 'proof.json');
    fs.writeFileSync(proofFile, JSON.stringify(proofs.find((p) => p.records[0].record.docHash === (direct['C v1 copy'] as { matched: { docHash: Hex } }).matched.docHash)));
    const archiveFile = path.join(work, 'archive.json');
    fs.writeFileSync(archiveFile, JSON.stringify(archive));
    for (const given of [archiveFile, proofFile]) {
      const { stdout } = await run(process.execPath, ['bin/verify-report.mjs', pdf, '--deployment', targetFile, '--rpc', targetNode.url, '--rpc', targetNode.url, '--reanchor', given], { cwd: ROOT });
      const out = JSON.parse(stdout);
      expect(out.verdict).toEqual({ ...direct['C v1 copy'], asOfBlock: archive.source.block });
      expect(out.reanchored).toMatchObject({ index: 1, root: archive.root, sourceBlock: archive.source.block });
    }
    // Without it, the verifier's registry does not know the chain the file names.
    const { stdout } = await run(process.execPath, ['bin/verify-report.mjs', pdf, '--deployment', targetFile, '--rpc', targetNode.url, '--rpc', targetNode.url], { cwd: ROOT });
    expect(JSON.parse(stdout)).toMatchObject({ verdict: { kind: 'UNKNOWN_REGISTRY', claimedChainId: SEPOLIA }, reanchored: null });
  }, 120_000);

  it('a voided root is no longer accepted', async () => {
    const wallet = createWalletClient({ chain: foundry, transport: http(targetNode.url), account: owner });
    await target.publicClient.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: target.deployment.address, abi: registryAbi, functionName: 'voidReanchorRoot', args: [1n] }) });
    await finalise(target);
    expect(await throughSets(files['A v2'], [set])).toEqual({ verdict: { kind: 'CANNOT_VERIFY', reason: 'REANCHOR_ROOT_NOT_RECORDED' }, reanchored: null });
  });
});
