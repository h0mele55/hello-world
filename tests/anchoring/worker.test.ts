import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  getAddress,
  http,
  keccak256,
  parseEther,
  toBytes,
  type Address,
  type Hex,
  type PublicClient,
  type TestClient,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import type { SessionUser } from '@/auth';
import { PrismaClient } from '@/generated/prisma/client';
import { approveVersion, setChainWriteMode } from '@/lib/anchoring/approve';
import { AnchoringError } from '@/lib/anchoring/errors';
import type { AnchorTarget } from '@/lib/anchoring/target';
import { runWorkerPass, type WorkerDeps } from '@/lib/anchoring/worker';
import { verifyAuditChain } from '@/lib/audit';
import { deployRegistry, orgIdFor } from '@/lib/chain/deploy';
import type { Deployment } from '@/lib/chain/deployment';
import { createRegistryReader, type RegistryReader } from '@/lib/chain/reader';
import { recordIdFor, ZERO_HASH } from '@/lib/chain/records';
import { registryAbi } from '@/lib/chain/registry-artifact';
import { confirmOpinion, createEngagement, uploadVersion } from '@/lib/reports/intake';
import { startAnvil, type AnvilHandle } from '../integration/anvil';

/**
 * The anchoring worker against a real Postgres and a throwaway Anvil chain.
 * Anvil runs with `--slots-in-an-epoch 1`, so `finalized` trails `latest` by
 * two blocks. Each test starts from an Anvil snapshot and empty tables.
 */

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
const fixture = (name: string) => fs.readFileSync(path.join(import.meta.dirname, '..', 'fixtures', 'pdf', name));
const h = (label: string): Hex => keccak256(toBytes(label));

let anvil: AnvilHandle;
let publicClient: PublicClient;
let testClient: TestClient;
let issuerKey: Hex;
let issuer: PrivateKeyAccount;
let deployment: Deployment;
let reader: RegistryReader;
let target: AnchorTarget;
let lockClient: pg.Client;
let snapshot: Hex;
let clock: Date;

let preparer: SessionUser;
let approver: SessionUser;
let refCounter = 0;

const issuerWallet = () => createWalletClient({ chain: foundry, transport: http(anvil.url), account: issuer });
const nonceOf = (blockTag: 'latest' | 'pending' = 'latest') => publicClient.getTransactionCount({ address: issuer.address, blockTag });
const mine = (blocks = 3) => testClient.mine({ blocks });

function deps(overrides: Partial<WorkerDeps> = {}): WorkerDeps {
  return { prisma, lockClient, publicClient, account: issuer, deployment, now: () => clock, log: () => {}, ...overrides };
}
const pass = (overrides: Partial<WorkerDeps> = {}) => runWorkerPass(deps(overrides));
const advance = (ms: number) => {
  clock = new Date(clock.getTime() + ms);
};

async function engagement() {
  refCounter += 1;
  return createEngagement(preparer, {
    clientName: 'Example Manufacturing AD',
    registrationNumber: '123456789',
    country: 'BG',
    engagementRef: `ENG-W-${refCounter}`,
    periodEnd: '2025-12-31',
    reportType: 'STANDALONE',
  });
}

async function confirmedVersion(engagementId: string, file: string, reasonCode: 'INITIAL' | 'CORRECTION' = 'INITIAL') {
  const uploaded = await uploadVersion(preparer, { engagementId, reasonCode, bytes: fixture(file) });
  await confirmOpinion(preparer, { versionId: uploaded.id, opinionType: 'UNMODIFIED', text: 'In our opinion, the financial statements present fairly.', reportDate: '2026-03-31' });
  return uploaded.id;
}

async function goLive() {
  await setChainWriteMode(approver, 'DRY_RUN');
  await setChainWriteMode(approver, 'LIVE');
}

const writeOf = (chainWriteId: string) => prisma.chainWrite.findUniqueOrThrow({ where: { id: chainWriteId } });
const versionOf = (versionId: string) =>
  prisma.reportVersion.findUniqueOrThrow({ where: { id: versionId }, include: { engagement: true } });

/** Approve, send, mine to finality, settle: the happy path, for tests that need an anchored version. */
async function anchorThrough(versionId: string) {
  const { chainWriteId } = await approveVersion(approver, versionId, target);
  await pass();
  await mine();
  await pass();
  const write = await writeOf(chainWriteId);
  expect(write.status).toBe('FINAL');
  return write;
}

/** Anchors a version's exact commitments from outside the worker, as a lost earlier run would have. */
async function anchorDirectly(versionId: string, parentId: Hex = ZERO_HASH) {
  const v = await versionOf(versionId);
  const txHash = await issuerWallet().writeContract({
    address: deployment.address,
    abi: registryAbi,
    functionName: 'anchor',
    args: [v.engagement.familyId as Hex, v.version, parentId, v.docHash as Hex, v.manifestHash as Hex, v.opinionCommitment as Hex],
  });
  await publicClient.waitForTransactionReceipt({ hash: txHash });
  return txHash;
}

beforeAll(async () => {
  anvil = await startAnvil();
  const transport = http(anvil.url);
  publicClient = createPublicClient({ chain: foundry, transport, pollingInterval: 50 }) as PublicClient;
  testClient = createTestClient({ chain: foundry, mode: 'anvil', transport });
  // A fresh issuer key per run, funded by Anvil: no key appears in this repo.
  issuerKey = generatePrivateKey();
  issuer = privateKeyToAccount(issuerKey);
  await testClient.setBalance({ address: issuer.address, value: parseEther('10') });
  const [deployer] = await createWalletClient({ chain: foundry, transport }).getAddresses();
  deployment = await deployRegistry({
    publicClient,
    walletClient: createWalletClient({ chain: foundry, transport, account: getAddress(deployer) }),
    issuer: { address: issuer.address, orgId: orgIdFor('Example Audit OOD') },
  });
  reader = createRegistryReader(publicClient, deployment);
  target = { network: 'local', chainId: 31337, registry: getAddress(deployment.address), issuer: issuer.address };
  lockClient = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await lockClient.connect();
}, 60_000);

afterAll(async () => {
  await lockClient?.end();
  await prisma.$disconnect();
  await anvil?.stop();
});

beforeEach(async () => {
  snapshot = await testClient.snapshot();
  clock = new Date('2026-10-25T09:00:00Z');
  fs.rmSync(process.env.FILE_STORAGE_DIR!, { recursive: true, force: true });
  await prisma.$executeRawUnsafe('TRUNCATE "ChainWrite", "AuditEvent", "IssuerKeyStatus", "ReportVersion", "StoredFile", "Engagement", "Client", "User", "IssuerOrg" CASCADE');
  const org = await prisma.issuerOrg.create({ data: { name: 'Example Audit OOD' } });
  const make = async (email: string, role: 'PREPARER' | 'APPROVER'): Promise<SessionUser> => {
    const user = await prisma.user.create({ data: { orgId: org.id, email, name: email, role, passwordHash: 'x' } });
    return { id: user.id, email, name: email, role, orgId: org.id };
  };
  preparer = await make('preparer@example.test', 'PREPARER');
  approver = await make('approver@example.test', 'APPROVER');
});

afterEach(async () => {
  await testClient.setAutomine(true);
  await testClient.revert({ id: snapshot });
});

describe('LIVE anchoring', () => {
  it('anchors version 1: INTENT, BROADCAST, then FINAL once its block is finalized', async () => {
    await goLive();
    const e = await engagement();
    const versionId = await confirmedVersion(e.id, 'en-unmodified.pdf');
    const { chainWriteId } = await approveVersion(approver, versionId, target);

    const first = await pass();
    expect(first).toMatchObject({ ran: true, lowBalance: false, errors: [] });
    expect(first.steps).toEqual([expect.objectContaining({ writeId: chainWriteId, from: 'INTENT', to: 'BROADCAST' })]);
    const sent = await writeOf(chainWriteId);
    expect(sent).toMatchObject({ status: 'BROADCAST', nonce: 0, leaseUntil: null, parentId: ZERO_HASH });
    expect(sent.txHash).toMatch(/^0x[0-9a-f]{64}$/);

    // Mined but not yet finalized: still BROADCAST, a transaction hash is not an anchor (rule 2).
    const waiting = await pass();
    expect(waiting.steps[0]).toMatchObject({ from: 'BROADCAST', to: 'BROADCAST' });
    expect((await versionOf(versionId)).status).toBe('APPROVED');

    await mine();
    await pass();
    const final = await writeOf(chainWriteId);
    const v = await versionOf(versionId);
    const recordId = recordIdFor(31337, target.registry, v.engagement.familyId as Hex, 1, 'ORIGINAL');
    expect(final).toMatchObject({ status: 'FINAL', recordId, error: null });
    expect(v).toMatchObject({ status: 'ANCHORED', recordId, anchorTxHash: sent.txHash, anchorBlock: final.blockNumber });

    const onChain = await reader.findByDocHash(v.docHash as Hex);
    expect(onChain).toMatchObject({ recordId, version: 1, manifestHash: v.manifestHash, opinionCommitment: v.opinionCommitment, issuer: issuer.address });
    expect(await nonceOf()).toBe(1);

    const actions = (await prisma.auditEvent.findMany({ orderBy: { seq: 'asc' } })).map((e) => e.action);
    expect(actions.slice(-3)).toEqual(['version.approved', 'anchor.broadcast', 'anchor.final']);
    expect(await verifyAuditChain(prisma, preparer.orgId)).toMatchObject({ ok: true });
  });

  it('chains version 2 to version 1, which the family then resolves to', async () => {
    await goLive();
    const e = await engagement();
    const v1 = await confirmedVersion(e.id, 'en-unmodified.pdf');
    const v2 = await confirmedVersion(e.id, 'en-qualified.pdf', 'CORRECTION');
    const first = await anchorThrough(v1);
    const second = await anchorThrough(v2);
    expect(second.parentId).toBe(first.recordId);
    const familyId = (await versionOf(v2)).engagement.familyId as Hex;
    expect((await reader.latestOf(familyId))?.recordId).toBe(second.recordId);
    expect((await reader.getRecord(second.recordId as Hex))?.parentId).toBe(first.recordId);
  });

  it('fails a version 2 with StaleParent, sending nothing, when another version 2 lands after the parent was read', async () => {
    await goLive();
    const e = await engagement();
    const v1 = await confirmedVersion(e.id, 'en-unmodified.pdf');
    const v2 = await confirmedVersion(e.id, 'en-qualified.pdf', 'CORRECTION');
    const anchored = await anchorThrough(v1);
    const { chainWriteId } = await approveVersion(approver, v2, target);

    let nonceAfterCompetitor = -1;
    const report = await pass({
      faults: {
        afterBuild: async () => {
          const familyId = (await versionOf(v2)).engagement.familyId as Hex;
          const hash = await issuerWallet().writeContract({
            address: deployment.address,
            abi: registryAbi,
            functionName: 'anchor',
            args: [familyId, 2, anchored.recordId as Hex, h('competitor'), h('manifest'), h('opinion')],
          });
          await publicClient.waitForTransactionReceipt({ hash });
          nonceAfterCompetitor = await nonceOf('pending');
        },
      },
    });
    expect(report.steps[0]).toMatchObject({ from: 'INTENT', to: 'FAILED', note: 'StaleParent' });
    expect(await writeOf(chainWriteId)).toMatchObject({ status: 'FAILED', error: 'StaleParent', txHash: null, nonce: null });
    expect(await nonceOf('pending')).toBe(nonceAfterCompetitor);
    // The approval was for that attempt; another needs another approval.
    expect(await versionOf(v2)).toMatchObject({ status: 'CONFIRMED', approvedById: null });
  });

  it('links a document that is already on chain and sends nothing (idempotent)', async () => {
    await goLive();
    const e = await engagement();
    const versionId = await confirmedVersion(e.id, 'en-unmodified.pdf');
    const directTx = await anchorDirectly(versionId);
    await mine();
    const nonceBefore = await nonceOf('pending');

    const { chainWriteId } = await approveVersion(approver, versionId, target);
    const report = await pass();
    expect(report.steps[0]).toMatchObject({ from: 'INTENT', to: 'FINAL' });
    expect(await writeOf(chainWriteId)).toMatchObject({ status: 'FINAL', txHash: directTx, nonce: null });
    expect(await versionOf(versionId)).toMatchObject({ status: 'ANCHORED', anchorTxHash: directTx });
    expect(await nonceOf('pending')).toBe(nonceBefore);
    expect(await prisma.auditEvent.count({ where: { action: 'anchor.linked' } })).toBe(1);
  });

  it('refuses a document anchored as something else', async () => {
    await goLive();
    const e = await engagement();
    const versionId = await confirmedVersion(e.id, 'en-unmodified.pdf');
    const v = await versionOf(versionId);
    const hash = await issuerWallet().writeContract({
      address: deployment.address,
      abi: registryAbi,
      functionName: 'anchor',
      args: [h('another family'), 1, ZERO_HASH, v.docHash as Hex, h('m'), h('o')],
    });
    await publicClient.waitForTransactionReceipt({ hash });
    const { chainWriteId } = await approveVersion(approver, versionId, target);
    await pass();
    expect(await writeOf(chainWriteId)).toMatchObject({ status: 'FAILED', error: 'DOC_ANCHORED_ELSEWHERE' });
  });
});

describe('a worker that dies, and writes whose outcome is unknown', () => {
  it('a worker killed after sending leaves an INDETERMINATE write that settles to FINAL from chain state', async () => {
    await goLive();
    const e = await engagement();
    const versionId = await confirmedVersion(e.id, 'en-unmodified.pdf');
    const { chainWriteId } = await approveVersion(approver, versionId, target);

    const crashed = await pass({ faults: { afterSend: async () => Promise.reject(new Error('killed')) } });
    expect(crashed.errors).toEqual([{ writeId: chainWriteId, error: 'Error' }]);
    const orphan = await writeOf(chainWriteId);
    expect(orphan).toMatchObject({ status: 'INTENT', nonce: 0 });
    expect(orphan.txHash).toMatch(/^0x/);

    // Its lease still runs: no other worker touches it yet.
    expect((await pass()).steps).toEqual([]);
    advance(120_001);
    expect((await pass()).steps[0]).toMatchObject({ from: 'INTENT', to: 'INDETERMINATE', note: 'SEND_OUTCOME_UNKNOWN' });
    expect((await pass()).steps[0]).toMatchObject({ from: 'INDETERMINATE', to: 'BROADCAST', note: 'found on chain' });
    await mine();
    await pass();
    expect(await writeOf(chainWriteId)).toMatchObject({ status: 'FINAL', txHash: orphan.txHash });
    expect(await nonceOf()).toBe(1);
    const actions = (await prisma.auditEvent.findMany({ where: { subjectId: chainWriteId }, orderBy: { seq: 'asc' } })).map((e) => e.action);
    expect(actions).toEqual(['anchor.indeterminate', 'anchor.broadcast', 'anchor.final']);
  });

  it('holds a write whose bytes never left, blocks the key, and settles it once its nonce is used', async () => {
    await goLive();
    const a = await confirmedVersion((await engagement()).id, 'en-unmodified.pdf');
    const { chainWriteId: lost } = await approveVersion(approver, a, target);
    await pass({ faults: { beforeSend: async () => Promise.reject(new Error('killed')) } });
    advance(120_001);
    await pass();
    expect(await writeOf(lost)).toMatchObject({ status: 'INDETERMINATE', nonce: 0 });

    // Unknown, not mined, nonce unused: it cannot be settled, and is never resent.
    const held = await pass();
    expect(held.steps[0]).toMatchObject({ from: 'INDETERMINATE', to: 'INDETERMINATE' });
    expect(await nonceOf('pending')).toBe(0);

    // A second write waits: its nonce would depend on the first.
    const b = await confirmedVersion((await engagement()).id, 'en-qualified.pdf');
    const { chainWriteId: next } = await approveVersion(approver, b, target);
    await pass();
    expect(await writeOf(next)).toMatchObject({ status: 'INTENT', error: 'ISSUER_BLOCKED', txHash: null });

    // The operator uses nonce 0 with a no-op transaction; the worker reads the outcome.
    const noop = await issuerWallet().sendTransaction({ to: issuer.address, value: 0n, nonce: 0 });
    await publicClient.waitForTransactionReceipt({ hash: noop });
    await mine();
    const settled = await pass();
    expect(settled.steps.map((s) => [s.writeId, s.to])).toEqual([
      [lost, 'FAILED'],
      [next, 'BROADCAST'],
    ]);
    expect(await writeOf(lost)).toMatchObject({ error: 'NONCE_CONSUMED', nonce: null });
    expect(await versionOf(a)).toMatchObject({ status: 'CONFIRMED' });
    expect(await writeOf(next)).toMatchObject({ nonce: 1 });
  });

  it('replaces a transaction stuck for 10 minutes at the same nonce with higher fees', async () => {
    await goLive();
    const versionId = await confirmedVersion((await engagement()).id, 'en-unmodified.pdf');
    const { chainWriteId } = await approveVersion(approver, versionId, target);
    await testClient.setAutomine(false);
    await pass();
    const original = await writeOf(chainWriteId);
    expect(original.status).toBe('BROADCAST');

    advance(5 * 60_000);
    expect((await pass()).steps[0]).toMatchObject({ to: 'BROADCAST', note: 'pending' });
    advance(5 * 60_000);
    expect((await pass()).steps[0]).toMatchObject({ to: 'BROADCAST', note: 'replaced at nonce 0' });
    const replaced = await writeOf(chainWriteId);
    expect(replaced.nonce).toBe(0);
    expect(replaced.txHash).not.toBe(original.txHash);
    expect(replaced.replacedTxHashes).toEqual([original.txHash]);
    expect(BigInt(replaced.maxFeePerGas!)).toBeGreaterThanOrEqual((BigInt(original.maxFeePerGas!) * 120n) / 100n);
    expect(BigInt(replaced.maxPriorityFeePerGas!)).toBeGreaterThanOrEqual((BigInt(original.maxPriorityFeePerGas!) * 120n) / 100n);

    await mine(4);
    await testClient.setAutomine(true);
    await pass();
    const final = await writeOf(chainWriteId);
    expect(final).toMatchObject({ status: 'FINAL', txHash: replaced.txHash, replacedTxHashes: [original.txHash] });
    expect(await nonceOf()).toBe(1);
  });

  it('lets one worker at a time work an issuer key', async () => {
    const other = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await other.connect();
    try {
      await other.query('SELECT pg_advisory_lock(2, hashtext($1))', [`31337:${issuer.address.toLowerCase()}`]);
      expect(await pass()).toMatchObject({ ran: false, reason: 'ISSUER_LOCKED' });
    } finally {
      await other.end();
    }
    expect(await pass()).toMatchObject({ ran: true });
  });
});

describe('the write ladder and the key', () => {
  it('DRY_RUN simulates and records, and never broadcasts', async () => {
    await setChainWriteMode(approver, 'DRY_RUN');
    const versionId = await confirmedVersion((await engagement()).id, 'en-unmodified.pdf');
    const nonceBefore = await nonceOf('pending');
    const { chainWriteId, mode } = await approveVersion(approver, versionId, target);
    expect(mode).toBe('DRY_RUN');
    const report = await pass();
    expect(report.steps[0]).toMatchObject({ from: 'INTENT', to: 'SIMULATED', note: 'would succeed' });
    expect(await writeOf(chainWriteId)).toMatchObject({ status: 'SIMULATED', error: null, txHash: null, nonce: null });
    expect(await versionOf(versionId)).toMatchObject({ status: 'CONFIRMED', approvedById: null });
    expect(await nonceOf('pending')).toBe(nonceBefore);

    // A simulation that would revert records the contract's reason: here the
    // file is already anchored, under another family.
    const v = await versionOf(versionId);
    const elsewhere = await issuerWallet().writeContract({
      address: deployment.address,
      abi: registryAbi,
      functionName: 'anchor',
      args: [h('another family'), 1, ZERO_HASH, v.docHash as Hex, h('m'), h('o')],
    });
    await publicClient.waitForTransactionReceipt({ hash: elsewhere });
    const nonceAfterDirect = await nonceOf('pending');
    const again = await approveVersion(approver, versionId, target);
    await pass();
    expect(await writeOf(again.chainWriteId)).toMatchObject({ status: 'SIMULATED', error: 'DocAlreadyAnchored' });
    expect(await nonceOf('pending')).toBe(nonceAfterDirect);
    expect(await prisma.auditEvent.count({ where: { action: 'anchor.simulated' } })).toBe(2);
  });

  it('a write approved under LIVE does not start once the mode is narrowed', async () => {
    await goLive();
    const versionId = await confirmedVersion((await engagement()).id, 'en-unmodified.pdf');
    const { chainWriteId } = await approveVersion(approver, versionId, target);
    await setChainWriteMode(approver, 'DRY_RUN');
    await pass();
    expect(await writeOf(chainWriteId)).toMatchObject({ status: 'FAILED', error: 'MODE_NARROWED' });
    expect(await nonceOf('pending')).toBe(0);
    await setChainWriteMode(approver, 'DISABLED');
    await expect(approveVersion(approver, versionId, target)).rejects.toBeInstanceOf(AnchoringError);
  });

  it('reports a low balance, and gives the nonce back when the node refuses the bytes', async () => {
    await goLive();
    const versionId = await confirmedVersion((await engagement()).id, 'en-unmodified.pdf');
    const { chainWriteId } = await approveVersion(approver, versionId, target);
    await testClient.setBalance({ address: issuer.address, value: 1000n });
    const report = await pass();
    expect(report).toMatchObject({ lowBalance: true, balanceWei: 1000n });
    expect(await prisma.issuerKeyStatus.findUniqueOrThrow({ where: { chainId_address: { chainId: 31337, address: issuer.address } } })).toMatchObject({ low: true, balanceWei: '1000' });
    expect(await writeOf(chainWriteId)).toMatchObject({ status: 'FAILED', error: 'SEND_REJECTED:INSUFFICIENT_FUNDS', nonce: null });
    expect(await nonceOf('pending')).toBe(0);

    await testClient.setBalance({ address: issuer.address, value: parseEther('1') });
    expect(await pass()).toMatchObject({ lowBalance: false });
  });

  it('refuses to work against a chain that does not hold the expected registry', async () => {
    const wrong: Deployment = { ...deployment, address: '0x000000000000000000000000000000000000dEaD' as Address };
    expect(await pass({ deployment: wrong })).toMatchObject({ ran: false, reason: 'DEPLOYMENT_MISMATCH' });
  });
});

describe('the worker process', () => {
  const ROOT = path.resolve(import.meta.dirname, '..', '..');
  const run = promisify(execFile);

  /** Runs scripts/worker.ts --once from a directory holding a deployments/local.json for this Anvil. */
  async function runScript(env: Record<string, string>) {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-worker-'));
    fs.mkdirSync(path.join(cwd, 'deployments'));
    const { chainId, address, runtimeBytecodeHash } = deployment;
    fs.writeFileSync(path.join(cwd, 'deployments', 'local.json'), JSON.stringify({ chainId, address, runtimeBytecodeHash }));
    try {
      return await run(path.join(ROOT, 'node_modules', '.bin', 'tsx'), ['--tsconfig', path.join(ROOT, 'tsconfig.json'), path.join(ROOT, 'scripts', 'worker.ts'), '--once'], {
        cwd,
        encoding: 'utf8',
        env: { NODE_ENV: 'test', PATH: process.env.PATH, DATABASE_URL: process.env.DATABASE_URL, ANCHOR_NETWORK: 'local', LOCAL_RPC_URL: anvil.url, ISSUER_PRIVATE_KEY: issuerKey, ...env },
      });
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }

  it('reads its key from the environment and works the journal', async () => {
    await goLive();
    const versionId = await confirmedVersion((await engagement()).id, 'en-unmodified.pdf');
    const { chainWriteId } = await approveVersion(approver, versionId, target);
    const { stdout } = await runScript({ ISSUER_ADDRESS: issuer.address });
    expect(stdout).toContain('"message":"pass"');
    expect(stdout).not.toContain(issuerKey.slice(2));
    expect((await writeOf(chainWriteId)).status).toBe('BROADCAST');
    await mine();
    await runScript({});
    expect((await writeOf(chainWriteId)).status).toBe('FINAL');
  });

  it('refuses to start when ISSUER_ADDRESS is not its key', async () => {
    const failed = await runScript({ ISSUER_ADDRESS: '0x000000000000000000000000000000000000dEaD' }).then(
      () => null,
      (e: { code: number; stderr: string }) => e,
    );
    expect(failed?.code).toBe(1);
    expect(failed?.stderr).toContain('ISSUER_ADDRESS is not the address of ISSUER_PRIVATE_KEY');
  });
});
