import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { PrismaPg } from '@prisma/adapter-pg';
import { bytesToHex, createPublicClient, http, sha256, type Hex, type PublicClient } from 'viem';
import { foundry } from 'viem/chains';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@/generated/prisma/client';
import { exportCheckpoint, runCheckpoint, type CheckpointDeps } from '@/lib/anchoring/checkpoint';
import { orgIdFor } from '@/lib/chain/deploy';
import { attestationsOf, parseProof, serializeProof, serializeTimestamp, type Proof, type Timestamp } from '@/lib/ots/format';
import type { BitcoinTime } from '@/lib/ots/bitcoin';
import { runOtsPass } from '@/lib/ots/job';
import { stampPdf } from '@/lib/stamp';
import { checkReanchorSet, openRegistryView, verifyFile, verifyWithReanchors, type CheckedSet, type Verdict, type VerifierConfig } from '@/lib/verify-core';
import { checkpointDigest, checkpointHead, type Checkpoint } from '@/lib/verify-core/reanchor';
import { startAnvil, type AnvilHandle } from '../integration/anvil';
import { anchorCopy, anchorOriginal, deployOn, finalise, ISSUER_ORG, readPdf, stampFor, type Registry } from '../integration/registry-harness';

/**
 * The monthly checkpoint (#122), against a real Postgres and a throwaway Anvil
 * chain: the month's records go under one root, once; the OpenTimestamps job
 * timestamps sha256 of that root (fake calendars, a stubbed Bitcoin check, as
 * in tests/db/ots.test.ts); the checkpoint is exported once that proof is
 * complete; and with the chain stopped, every record of the month verifies
 * through it, as of its block.
 */

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
const fixture = (name: string) => new Uint8Array(fs.readFileSync(path.join(import.meta.dirname, '..', 'fixtures', 'pdf', name)));
const family = (n: number) => `0x${n.toString(16).padStart(2, '0').repeat(32)}` as Hex;
const NOW = new Date('2026-11-01T02:00:00Z');
const ALICE = 'https://alice.example';
const BOB = 'https://bob.example';
const HEIGHT = 920_000;
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const run = promisify(execFile);

let anvil: AnvilHandle;
let registry: Registry;
let clients: [PublicClient, PublicClient];
let config: VerifierConfig;
let orgId: string;
let deps: CheckpointDeps;
const files: Record<string, Uint8Array> = {};
const direct: Record<string, Verdict> = {};

/** Calendars that take every digest at once, and answer with a path to Bitcoin once asked again. */
const pendingAt = (uri: string): Timestamp => ({ attestations: [], ops: [{ op: { op: 'sha256' }, next: { attestations: [{ kind: 'pending', uri }], ops: [] } }] });
const confirmed: Timestamp = { attestations: [], ops: [{ op: { op: 'append', arg: new Uint8Array([1]) }, next: { attestations: [], ops: [{ op: { op: 'sha256' }, next: { attestations: [{ kind: 'bitcoin', height: HEIGHT }], ops: [] } }] } }] };
const calendar = {
  calendars: [ALICE, BOB],
  fetch: (async (url: string | URL | Request) => {
    const u = new URL(String(url));
    return new Response(serializeTimestamp(u.pathname === '/digest' ? pendingAt(u.origin) : confirmed));
  }) as typeof fetch,
};
/** The Bitcoin check, stubbed: a proof with a Bitcoin attestation reaches the block. */
const bitcoinTime = async (proof: Proof): Promise<BitcoinTime | null> =>
  attestationsOf(proof).some((a) => a.attestation.kind === 'bitcoin') ? { height: HEIGHT, blockHash: `0x${'00'.repeat(10)}${'ab'.repeat(22)}`, time: 1_793_500_000 } : null;

beforeAll(async () => {
  anvil = await startAnvil();
  // A revocation that waits out the delay: a checkpoint holds it pending, as it was then.
  registry = await deployOn(anvil.url, { revocationDelaySeconds: 3600 });
  const a1 = await anchorOriginal(registry, fixture('en-unmodified.pdf'), family(0xa1));
  files['A v1'] = fixture('en-unmodified.pdf');
  files['A v1 copy'] = await stampPdf(fixture('en-unmodified.pdf'), stampFor(registry, a1));
  await anchorCopy(registry, a1, files['A v1 copy']);
  await anchorOriginal(registry, fixture('en-qualified.pdf'), family(0xa1), 2, a1.recordId);
  files['A v2'] = fixture('en-qualified.pdf');
  const b1 = await anchorOriginal(registry, fixture('en-adverse.pdf'), family(0xb1));
  files['B v1, being revoked'] = fixture('en-adverse.pdf');
  await registry.publicClient.waitForTransactionReceipt({ hash: (await registry.adapter.revoke(b1.recordId, 2)).txHash });
  await finalise(registry);

  const client = () => createPublicClient({ chain: foundry, transport: http(anvil.url) }) as PublicClient;
  clients = [client(), client()];
  config = { chainId: registry.deployment.chainId, registry: registry.deployment.address, runtimeBytecodeHash: registry.deployment.runtimeBytecodeHash, rpcUrls: [anvil.url, anvil.url] };
  for (const [name, bytes] of Object.entries(files)) direct[name] = await verifyFile({ bytes, config, openView: () => openRegistryView(config), readPdf });

  await prisma.$executeRawUnsafe('TRUNCATE "OtsProof", "RegistryCheckpoint", "AuditEvent", "IssuerOrg" CASCADE');
  orgId = (await prisma.issuerOrg.create({ data: { name: ISSUER_ORG } })).id;
  deps = { prisma, clients, deployment: { ...registry.deployment, deployBlock: 0 }, firm: { orgId, name: ISSUER_ORG }, now: () => NOW };
}, 120_000);

afterAll(async () => {
  await anvil?.stop();
  await prisma.$disconnect();
});

describe('the monthly checkpoint (#122)', () => {
  let made: { checkpointId: string; root: Hex; block: number };
  /** What October's timestamp is of. */
  const head = () => ({ source: { chainId: config.chainId, registry: config.registry, block: made.block }, period: '2026-10', count: 4, root: made.root });
  let exported: Checkpoint;
  let proofs: CheckedSet[];

  it('makes the month’s checkpoint once, of every record at one finalized block, and keeps it as written', async () => {
    const outcome = await runCheckpoint(deps);
    expect(outcome).toMatchObject({ status: 'CREATED', period: '2026-10', count: 4 });
    if (outcome.status !== 'CREATED') throw new Error(outcome.status);
    made = outcome;

    const row = await prisma.registryCheckpoint.findUniqueOrThrow({ where: { id: outcome.checkpointId } });
    expect(row).toMatchObject({ orgId, chainId: config.chainId, registry: config.registry.toLowerCase(), period: '2026-10', root: outcome.root, count: 4, block: outcome.block });
    const stored = checkReanchorSet(JSON.parse(new TextDecoder().decode(row.file)));
    expect(stored).toMatchObject({ complete: true, root: outcome.root, checkpoint: { period: '2026-10', ots: null }, target: null });
    // A revocation still waiting out the delay is held as pending.
    expect(stored.records.find((r) => r.revokeReason === 2)).toMatchObject({ revoked: false });
    const event = await prisma.auditEvent.findFirstOrThrow({ where: { orgId, action: 'checkpoint.created' } });
    expect(event.data).toMatchObject({ period: '2026-10', root: outcome.root, count: 4, block: outcome.block });

    // A second run in the month changes nothing, and the row cannot be changed.
    expect(await runCheckpoint(deps)).toEqual({ status: 'EXISTS', checkpointId: outcome.checkpointId, period: '2026-10' });
    await expect(prisma.registryCheckpoint.update({ where: { id: outcome.checkpointId }, data: { count: 5 } })).rejects.toThrow(/append-only/);
  });

  it('has nothing to checkpoint for a registry with no records', async () => {
    const empty = await deployOn(anvil.url);
    await finalise(empty);
    expect(await runCheckpoint({ ...deps, deployment: { ...empty.deployment, deployBlock: 0 } })).toEqual({ status: 'EMPTY', period: '2026-10' });
  });

  it('is timestamped through the OpenTimestamps job, and exported only once that proof is complete', async () => {
    const where = { orgId, chainId: config.chainId, registry: config.registry, period: '2026-10' };
    expect(await exportCheckpoint(prisma, where)).toEqual({ status: 'NOT_YET', reason: 'NOT_SUBMITTED' });

    const first = await runOtsPass({ prisma, calendar, bitcoinTime, now: () => NOW });
    expect(first.submitted).toEqual([made.checkpointId]);
    const proof = await prisma.otsProof.findUniqueOrThrow({ where: { checkpointId: made.checkpointId } });
    // The digest is the SHA-256 of the checkpoint's head, so the reference client checks it against a file holding the head.
    expect(proof.digest).toBe(checkpointDigest(head()));
    expect(proof.reportVersionId).toBeNull();
    expect(await exportCheckpoint(prisma, where)).toEqual({ status: 'NOT_YET', reason: 'PENDING' });

    const second = await runOtsPass({ prisma, calendar, bitcoinTime, now: () => new Date(NOW.getTime() + 60 * 60_000) });
    expect(second.complete).toEqual([made.checkpointId]);
    expect((await prisma.auditEvent.findMany({ where: { orgId, action: { startsWith: 'ots.' } }, orderBy: { seq: 'asc' } })).map((e) => [e.action, e.subjectType])).toEqual([
      ['ots.submitted', 'RegistryCheckpoint'],
      ['ots.complete', 'RegistryCheckpoint'],
    ]);

    const ready = await exportCheckpoint(prisma, where);
    if (ready.status !== 'READY') throw new Error(ready.status);
    expect(ready.bitcoinHeight).toBe(HEIGHT);
    expect(bytesToHex(ready.head)).toBe(bytesToHex(checkpointHead(head())));
    expect(bytesToHex(ready.head)).toContain(made.root.slice(2));
    expect(Buffer.from(ready.checkpoint.ots!, 'base64').equals(Buffer.from(ready.ots))).toBe(true);
    exported = ready.checkpoint;
    proofs = ready.proofs.map((p) => checkReanchorSet(JSON.parse(JSON.stringify(p))));
    expect(proofs).toHaveLength(4);
    expect(checkReanchorSet(JSON.parse(JSON.stringify(exported)))).toMatchObject({ complete: true, count: 4, root: made.root });
  });

  it('is exported by the script as it is published: the file, the proofs, and the head with its .ots', async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-export-'));
    const deployment = path.join(work, 'local.json');
    fs.writeFileSync(deployment, JSON.stringify({ network: 'local', ...registry.deployment, issuer: { orgId: orgIdFor(ISSUER_ORG), orgName: ISSUER_ORG } }));
    const env = { PATH: process.env.PATH, DATABASE_URL: process.env.DATABASE_URL, ANCHOR_NETWORK: 'local', LOCAL_RPC_URL: anvil.url, DEPLOYMENT_FILE: deployment } as unknown as NodeJS.ProcessEnv;
    const out = path.join(work, 'published');
    const { stdout } = await run(path.join(ROOT, 'node_modules', '.bin', 'tsx'), ['scripts/checkpoint.ts', '--export', '2026-10', '--out', out], { cwd: ROOT, env });
    expect(JSON.parse(stdout)).toMatchObject({ period: '2026-10', root: made.root, records: 4, bitcoinHeight: HEIGHT });
    expect(JSON.parse(fs.readFileSync(path.join(out, 'checkpoint.json'), 'utf8'))).toEqual(exported);
    expect(fs.readdirSync(path.join(out, 'proofs'))).toHaveLength(4);
    const headFile = new Uint8Array(fs.readFileSync(path.join(out, 'head')));
    expect(bytesToHex(headFile)).toBe(bytesToHex(checkpointHead(head())));
    // The .ots is of the head file's SHA-256, as the reference client reads it.
    expect(bytesToHex(parseProof(new Uint8Array(fs.readFileSync(path.join(out, 'head.ots')))).digest)).toBe(sha256(headFile));
    // Never written over; and a month with no checkpoint is named.
    await expect(run(path.join(ROOT, 'node_modules', '.bin', 'tsx'), ['scripts/checkpoint.ts', '--export', '2026-10', '--out', out], { cwd: ROOT, env })).rejects.toMatchObject({ code: 2 });
    await expect(run(path.join(ROOT, 'node_modules', '.bin', 'tsx'), ['scripts/checkpoint.ts', '--export', '2026-09', '--out', path.join(work, 'none')], { cwd: ROOT, env })).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining('no checkpoint for 2026-09'),
    });
  }, 120_000);

  it('gives a month without new records a checkpoint and a timestamp of its own', async () => {
    const november = await runCheckpoint({ ...deps, now: () => new Date('2026-12-01T02:00:00Z') });
    if (november.status !== 'CREATED') throw new Error(november.status);
    expect(november).toMatchObject({ period: '2026-11', root: made.root, count: 4 });
    expect(november.block).toBeGreaterThan(made.block);
    const report = await runOtsPass({ prisma, calendar, bitcoinTime, now: () => NOW });
    expect(report.submitted).toEqual([november.checkpointId]);
    const digests = await prisma.otsProof.findMany({ where: { checkpointId: { not: null } }, select: { digest: true } });
    expect(new Set(digests.map((d) => d.digest)).size).toBe(2);
  });

  it('is not used while the registry answers', async () => {
    const set = checkReanchorSet(JSON.parse(JSON.stringify(exported)));
    const live = await verifyWithReanchors({ bytes: files['A v2'], config, openView: () => openRegistryView(config), readPdf, sets: [set], bitcoinCheck: bitcoinTime });
    expect(live.reanchored).toBeNull();
    // The live answer, at the chain's current finalized block, past the checkpoint's.
    if (live.verdict.kind !== 'AUTHENTIC_LATEST') throw new Error(live.verdict.kind);
    expect(live.verdict.asOfBlock).toBeGreaterThan(made.block);
    expect({ ...live.verdict, asOfBlock: 0 }).toEqual({ ...direct['A v2'], asOfBlock: 0 });
  });

  it('with the chain stopped, every record of the month verifies through it, as of its block', async () => {
    await anvil.stop();
    const set = checkReanchorSet(JSON.parse(JSON.stringify(exported)));
    expect(await verifyFile({ bytes: files['A v2'], config, openView: () => openRegistryView(config), readPdf })).toEqual({ kind: 'CANNOT_VERIFY', reason: 'RPC_UNREACHABLE' });
    expect(Object.fromEntries(Object.entries(direct).map(([name, v]) => [name, v.kind]))).toEqual({
      'A v1': 'AUTHENTIC_SUPERSEDED',
      'A v1 copy': 'AUTHENTIC_SUPERSEDED',
      'A v2': 'AUTHENTIC_LATEST',
      'B v1, being revoked': 'REVOCATION_PENDING',
    });
    for (const [name, bytes] of Object.entries(files)) {
      const { verdict, reanchored } = await verifyWithReanchors({ bytes, config, openView: () => openRegistryView(config), readPdf, sets: [set], bitcoinCheck: bitcoinTime });
      expect(verdict, name).toEqual({ ...direct[name], asOfBlock: made.block });
      expect(reanchored, name).toMatchObject({ kind: 'checkpoint', period: '2026-10', root: made.root, sourceBlock: made.block, bitcoin: { height: HEIGHT } });
    }
    // One record's proof answers for its file.
    const ownProof = proofs.find((p) => p.records[0].docHash === (direct['A v1 copy'] as { matched: { docHash: Hex } }).matched.docHash)!;
    expect((await verifyWithReanchors({ bytes: files['A v1 copy'], config, openView: () => openRegistryView(config), readPdf, sets: [ownProof], bitcoinCheck: bitcoinTime })).verdict).toEqual({
      ...direct['A v1 copy'],
      asOfBlock: made.block,
    });
  });

  it('never says "none": a file it does not hold may have come after it', async () => {
    const set = checkReanchorSet(JSON.parse(JSON.stringify(exported)));
    const verify = (bytes: Uint8Array, sets: CheckedSet[]) => verifyWithReanchors({ bytes, config, openView: () => openRegistryView(config), readPdf, sets, bitcoinCheck: bitcoinTime });
    expect(await verify(fixture('en-disclaimer.pdf'), [set])).toEqual({ verdict: { kind: 'CANNOT_VERIFY', reason: 'CHECKPOINT_NOT_COVERED' }, reanchored: null });
    // A proof of another record does not hold this file either.
    const ownProof = proofs.find((p) => p.records[0].docHash === (direct['A v2'] as { matched: { docHash: Hex } }).matched.docHash)!;
    expect((await verify(files['B v1, being revoked'], [ownProof])).verdict).toEqual({ kind: 'CANNOT_VERIFY', reason: 'CHECKPOINT_NOT_COVERED' });
  });

  it('is accepted only through its Bitcoin timestamp, of this very checkpoint', async () => {
    const verify = (edit: (c: Checkpoint) => void, check = bitcoinTime) => {
      const copy = JSON.parse(JSON.stringify(exported)) as Checkpoint;
      edit(copy);
      return verifyWithReanchors({ bytes: files['A v2'], config, openView: () => openRegistryView(config), readPdf, sets: [checkReanchorSet(copy)], bitcoinCheck: check });
    };
    const unproven = { verdict: { kind: 'CANNOT_VERIFY', reason: 'CHECKPOINT_UNPROVEN' }, reanchored: null };
    // Not timestamped yet.
    expect(await verify((c) => (c.ots = null))).toEqual(unproven);
    // A timestamp of something else.
    const other = serializeProof({ digest: new Uint8Array(32).fill(7), timestamp: confirmed });
    expect(await verify((c) => (c.ots = Buffer.from(other).toString('base64')))).toEqual(unproven);
    // Not on Bitcoin yet, by the explorers' reading.
    expect(await verify(() => {}, async () => null)).toEqual(unproven);
  });

  it('through the CLI: --checkpoint with the chain down, held to the timestamp it carries', async () => {
    execFileSync(path.join(ROOT, 'node_modules', '.bin', 'tsx'), ['scripts/build-verifier.ts', '--cli-only'], { cwd: ROOT, stdio: 'pipe' });
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-cli-'));
    const deployment = path.join(work, 'local.json');
    fs.writeFileSync(deployment, JSON.stringify({ network: 'local', ...registry.deployment }));
    const pdf = path.join(work, 'report.pdf');
    fs.writeFileSync(pdf, files['A v2']);
    // Calendars have taken the root but Bitcoin has not: no explorer is asked anything.
    const pending = { ...exported, ots: Buffer.from(serializeProof({ digest: Buffer.from(checkpointDigest(head()).slice(2), 'hex'), timestamp: pendingAt(ALICE) })).toString('base64') };
    const file = path.join(work, 'checkpoint.json');
    fs.writeFileSync(file, JSON.stringify(pending));
    const cli = run(process.execPath, ['bin/verify-report.mjs', pdf, '--deployment', deployment, '--rpc', anvil.url, '--rpc', anvil.url, '--checkpoint', file], { cwd: ROOT });
    await expect(cli).rejects.toMatchObject({ code: 3 });
    const out = JSON.parse(((await cli.catch((e: { stdout: string }) => e)) as { stdout: string }).stdout);
    expect(out).toMatchObject({ verdict: { kind: 'CANNOT_VERIFY', reason: 'CHECKPOINT_UNPROVEN' }, reanchored: null });
    // A file that is not a checkpoint is refused before anything is read.
    fs.writeFileSync(file, JSON.stringify({ ...pending, root: `0x${'0'.repeat(64)}` }));
    await expect(run(process.execPath, ['bin/verify-report.mjs', pdf, '--checkpoint', file], { cwd: ROOT })).rejects.toMatchObject({ code: 2 });
  }, 120_000);
});
