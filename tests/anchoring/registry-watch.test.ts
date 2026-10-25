import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import { createPublicClient, createTestClient, createWalletClient, getAddress, http, keccak256, parseEther, toBytes, type Hex, type PublicClient, type TestClient } from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import type { SessionUser } from '@/auth';
import { PrismaClient } from '@/generated/prisma/client';
import { approveVersion, setChainWriteMode } from '@/lib/anchoring/approve';
import { watchRegistry, type WatchDeps } from '@/lib/anchoring/registry-watch';
import type { AnchorTarget } from '@/lib/anchoring/target';
import { verifyAuditChain } from '@/lib/audit';
import { deployRegistry, orgIdFor } from '@/lib/chain/deploy';
import type { Deployment } from '@/lib/chain/deployment';
import { recordIdFor, ZERO_HASH } from '@/lib/chain/records';
import { registryAbi } from '@/lib/chain/registry-artifact';
import { openUnjournaledWrites, reviewUnjournaledWrite } from '@/lib/console/registry-watch';
import { confirmOpinion, createEngagement, uploadVersion } from '@/lib/reports/intake';
import { startAnvil, type AnvilHandle } from '../integration/anvil';

/**
 * The registry watch (#93) against a real Postgres and a throwaway Anvil
 * chain: a write by the firm's issuer key is reported unless the journal holds
 * its transaction hash, once, only when final, and stays open until an admin
 * reviews it. Writes are sent from here with the issuer key, as a thief would;
 * journal rows come from the app's own approval, as the worker's would.
 */

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
const fixture = (name: string) => fs.readFileSync(path.join(import.meta.dirname, '..', 'fixtures', 'pdf', name));
const h = (label: string): Hex => keccak256(toBytes(label));
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const FIRM = 'Example Audit OOD';
/** The registry's revocation delay here, so a reported revocation has a deadline. */
const DELAY = 3600;

let anvil: AnvilHandle;
let publicClient: PublicClient;
let testClient: TestClient;
let issuer: PrivateKeyAccount;
let otherFirmKey: PrivateKeyAccount;
let deployment: Deployment & { deployBlock: number };
let target: AnchorTarget;
let snapshot: Hex;
let orgId: string;
let preparer: SessionUser;
let approver: SessionUser;
let admin: SessionUser;
let outsider: SessionUser;
let refCounter = 0;

const mine = (blocks = 3) => testClient.mine({ blocks });
const watch = (overrides: Partial<WatchDeps> = {}) =>
  watchRegistry({ prisma, publicClient, deployment, firm: { orgId, onChainOrgId: orgIdFor(FIRM) }, fromBlock: BigInt(deployment.deployBlock), now: () => new Date('2026-10-25T12:00:00Z'), ...overrides });

/** A write as the issuer key's holder would send it, outside the app. */
async function sendAs(account: PrivateKeyAccount, call: { functionName: 'anchor'; args: readonly [Hex, number, Hex, Hex, Hex, Hex] } | { functionName: 'anchorDistributionCopy'; args: readonly [Hex, Hex] } | { functionName: 'revoke'; args: readonly [Hex, number] }) {
  const wallet = createWalletClient({ chain: foundry, transport: http(anvil.url), account });
  const hash = await wallet.writeContract({ address: deployment.address, abi: registryAbi, ...call } as Parameters<typeof wallet.writeContract>[0]);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  return { hash, blockNumber: receipt.blockNumber };
}
const forgedV1 = (account: PrivateKeyAccount, label: string) => sendAs(account, { functionName: 'anchor', args: [h(`family:${label}`), 1, ZERO_HASH, h(`doc:${label}`), h(`m:${label}`), h(`o:${label}`)] });

/** A journal row of the app's own, as approval leaves it: the hash goes in before anything is sent (rule 3). */
async function journalRow(file: string) {
  refCounter += 1;
  const engagement = await createEngagement(preparer, { clientName: 'Example Manufacturing AD', registrationNumber: '123456789', country: 'BG', engagementRef: `ENG-RW-${refCounter}`, periodEnd: '2025-12-31', reportType: 'STANDALONE' });
  const uploaded = await uploadVersion(preparer, { engagementId: engagement.id, reasonCode: 'INITIAL', bytes: fixture(file) });
  await confirmOpinion(preparer, { versionId: uploaded.id, opinionType: 'UNMODIFIED', text: 'In our opinion, the financial statements present fairly.', reportDate: '2026-03-31' });
  const { chainWriteId } = await approveVersion(approver, uploaded.id, target);
  return chainWriteId;
}

beforeAll(async () => {
  anvil = await startAnvil();
  const transport = http(anvil.url);
  publicClient = createPublicClient({ chain: foundry, transport, pollingInterval: 50 }) as PublicClient;
  testClient = createTestClient({ chain: foundry, mode: 'anvil', transport });
  issuer = privateKeyToAccount(generatePrivateKey());
  otherFirmKey = privateKeyToAccount(generatePrivateKey());
  for (const account of [issuer, otherFirmKey]) await testClient.setBalance({ address: account.address, value: parseEther('10') });
  const [deployer] = await createWalletClient({ chain: foundry, transport }).getAddresses();
  const ownerWallet = createWalletClient({ chain: foundry, transport, account: getAddress(deployer) });
  deployment = await deployRegistry({ publicClient, walletClient: ownerWallet, issuer: { address: issuer.address, orgId: orgIdFor(FIRM) }, revocationDelaySeconds: DELAY });
  const other = await ownerWallet.writeContract({ address: deployment.address, abi: registryAbi, functionName: 'setIssuer', args: [otherFirmKey.address, orgIdFor('Another Firm'), true] });
  await publicClient.waitForTransactionReceipt({ hash: other });
  target = { network: 'local', chainId: 31337, registry: getAddress(deployment.address), issuer: issuer.address };
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
  await anvil?.stop();
});

beforeEach(async () => {
  snapshot = await testClient.snapshot();
  fs.rmSync(process.env.FILE_STORAGE_DIR!, { recursive: true, force: true });
  await prisma.$executeRawUnsafe(
    'TRUNCATE "UnjournaledWrite", "RegistryWatch", "Revocation", "ChainWrite", "AuditEvent", "ReportVersion", "StoredFile", "Engagement", "Client", "User", "IssuerOrg" CASCADE',
  );
  const org = await prisma.issuerOrg.create({ data: { name: FIRM } });
  const another = await prisma.issuerOrg.create({ data: { name: 'Another Firm' } });
  orgId = org.id;
  const make = async (firm: string, email: string, role: 'PREPARER' | 'APPROVER' | 'ADMIN'): Promise<SessionUser> => {
    const user = await prisma.user.create({ data: { orgId: firm, email, name: email, role, passwordHash: 'x' } });
    return { id: user.id, email, name: email, role, orgId: firm, mfa: role === 'PREPARER' ? 'NOT_REQUIRED' : 'VERIFIED' };
  };
  preparer = await make(org.id, 'preparer@example.test', 'PREPARER');
  approver = await make(org.id, 'approver@example.test', 'APPROVER');
  admin = await make(org.id, 'admin@example.test', 'ADMIN');
  outsider = await make(another.id, 'admin@another.test', 'ADMIN');
  await setChainWriteMode(approver, 'DRY_RUN');
  await setChainWriteMode(approver, 'LIVE');
});

afterEach(async () => {
  await testClient.revert({ id: snapshot });
});

describe('the registry watch', () => {
  it('reports nothing for writes the journal holds, by their current or a replaced hash, and reads up to the finalized block', async () => {
    const current = await journalRow('en-unmodified.pdf');
    const replaced = await journalRow('en-qualified.pdf');
    const first = await forgedV1(issuer, 'journalled-1');
    const second = await forgedV1(issuer, 'journalled-2');
    await prisma.chainWrite.update({ where: { id: current }, data: { txHash: first.hash, status: 'BROADCAST' } });
    await prisma.chainWrite.update({ where: { id: replaced }, data: { txHash: h('a later replacement'), replacedTxHashes: [second.hash], status: 'BROADCAST' } });
    await mine();

    const report = await watch();
    const finalized = (await publicClient.getBlock({ blockTag: 'finalized' })).number;
    expect(report).toMatchObject({ seen: 2, found: [], open: 0, to: finalized });
    expect(await prisma.registryWatch.findFirstOrThrow({ where: { orgId } })).toMatchObject({ lastBlock: finalized, chainId: 31337 });
  });

  it('reports a forged version 1, a copy and a revocation by the firm’s key, once each and only when final, with the revocation’s deadline', async () => {
    const forged = await forgedV1(issuer, 'forged');
    const original = recordIdFor(31337, deployment.address, h('family:forged'), 1, 'ORIGINAL');
    const copy = await sendAs(issuer, { functionName: 'anchorDistributionCopy', args: [original, h('doc:forged-copy')] });
    const revocation = await sendAs(issuer, { functionName: 'revoke', args: [original, 1] });
    const revokedAt = Number((await publicClient.getBlock({ blockNumber: revocation.blockNumber })).timestamp);

    // Only what is final is read (rule 2): finalized trails the latest block by two here.
    const early = await watch();
    expect(early.found).toEqual([expect.objectContaining({ kind: 'ANCHOR', recordId: original, txHash: forged.hash, issuer: issuer.address, effectiveAt: null })]);
    await mine();
    const report = await watch();
    expect(report.found).toEqual([
      expect.objectContaining({ kind: 'ANCHOR_COPY', txHash: copy.hash }),
      expect.objectContaining({ kind: 'REVOCATION', recordId: original, txHash: revocation.hash, effectiveAt: revokedAt + DELAY }),
    ]);
    expect(report.open).toBe(3);

    // Reported once: a later run finds nothing new, and they stay open.
    expect(await watch()).toMatchObject({ found: [], open: 3 });
    const shown = await openUnjournaledWrites(admin);
    expect(shown.count).toBe(3);
    // The revocation first: it has a deadline.
    expect(shown.rows[0]).toMatchObject({ kind: 'REVOCATION', effectiveAt: new Date((revokedAt + DELAY) * 1000).toISOString() });
    const events = await prisma.auditEvent.findMany({ where: { orgId, action: 'registry_watch.unjournaled' } });
    expect(events).toHaveLength(3);
    expect(await verifyAuditChain(prisma, orgId)).toMatchObject({ ok: true });
  });

  it('ignores another firm’s keys', async () => {
    await forgedV1(otherFirmKey, 'theirs');
    await mine();
    expect(await watch()).toMatchObject({ seen: 0, found: [] });
  });

  it('reads in ranges, resumes from its checkpoint, and never reads a range twice', async () => {
    for (const label of ['r1', 'r2', 'r3']) {
      await forgedV1(issuer, label);
      await mine(2);
    }
    await mine();
    const report = await watch({ rangeBlocks: 2 });
    expect(report.found.map((f) => f.recordId)).toEqual(['r1', 'r2', 'r3'].map((l) => recordIdFor(31337, deployment.address, h(`family:${l}`), 1, 'ORIGINAL')));
    await forgedV1(issuer, 'r4');
    await mine();
    const next = await watch({ rangeBlocks: 2 });
    expect(next.from).toBe(report.to + 1n);
    expect(next.found.map((f) => f.recordId)).toEqual([recordIdFor(31337, deployment.address, h('family:r4'), 1, 'ORIGINAL')]);
    expect(next.open).toBe(4);
  });

  it('refuses a chain that does not hold the registry, rather than finding nothing', async () => {
    await expect(watch({ deployment: { ...deployment, address: issuer.address } })).rejects.toMatchObject({ code: 'BYTECODE_MISMATCH' });
    expect(await prisma.registryWatch.count()).toBe(0);
  });

  it('keeps a finding open until an admin of the firm reviews it, once', async () => {
    await forgedV1(issuer, 'review');
    await mine();
    await watch();
    const [finding] = (await openUnjournaledWrites(admin)).rows;
    await expect(reviewUnjournaledWrite(approver, finding.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(reviewUnjournaledWrite(outsider, finding.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await reviewUnjournaledWrite(admin, finding.id);
    await expect(reviewUnjournaledWrite(admin, finding.id)).rejects.toMatchObject({ code: 'ALREADY_REVIEWED' });
    expect(await prisma.unjournaledWrite.findUniqueOrThrow({ where: { id: finding.id } })).toMatchObject({ reviewedById: admin.id });
    expect(await watch()).toMatchObject({ open: 0 });
    expect(await prisma.auditEvent.count({ where: { orgId, action: 'registry_watch.reviewed', actorId: admin.id } })).toBe(1);
  });
});

describe('scripts/watch-registry.ts', () => {
  const run = promisify(execFile);

  async function script(file: string) {
    return run(path.join(ROOT, 'node_modules', '.bin', 'tsx'), ['scripts/watch-registry.ts'], {
      cwd: ROOT,
      env: { PATH: process.env.PATH, DATABASE_URL: process.env.DATABASE_URL, ANCHOR_NETWORK: 'local', LOCAL_RPC_URL: anvil.url, DEPLOYMENT_FILE: file } as unknown as NodeJS.ProcessEnv,
    }).then(
      (r) => ({ code: 0, out: r.stdout, err: r.stderr }),
      (e: { code: number; stdout: string; stderr: string }) => ({ code: e.code, out: e.stdout, err: e.stderr }),
    );
  }

  function deploymentFile(orgName: string) {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'watch-')), 'local.json');
    fs.writeFileSync(file, JSON.stringify({ network: 'local', ...deployment, issuer: { address: issuer.address, orgId: orgIdFor(orgName), orgName } }));
    return file;
  }

  it('exits 0 with nothing open, 1 while a finding is open, and 2 for a firm the database does not hold', async () => {
    const file = deploymentFile(FIRM);
    await mine();
    expect(await script(file)).toMatchObject({ code: 0, out: expect.stringContaining('"open":0') });
    await forgedV1(issuer, 'script');
    await mine();
    const alarm = await script(file);
    expect(alarm).toMatchObject({ code: 1, err: expect.stringContaining('THE JOURNAL DID NOT MAKE') });
    expect((await script(file)).code).toBe(1);
    await expect(script(deploymentFile('A Firm Nobody Seeded'))).resolves.toMatchObject({ code: 2, err: expect.stringContaining('holds no firm') });
  });
});
