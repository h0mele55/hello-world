import fs from 'node:fs';
import path from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPublicClient, createTestClient, createWalletClient, custom, getAddress, http, keccak256, parseEther, toBytes, type Hex, type PublicClient, type TestClient } from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import type { SessionUser } from '@/auth';
import { PrismaClient } from '@/generated/prisma/client';
import { approveVersion, setChainWriteMode } from '@/lib/anchoring/approve';
import { reconcileWithChain, type Difference } from '@/lib/anchoring/reconcile';
import type { AnchorTarget } from '@/lib/anchoring/target';
import { runWorkerPass } from '@/lib/anchoring/worker';
import { deployRegistry, orgIdFor } from '@/lib/chain/deploy';
import type { Deployment } from '@/lib/chain/deployment';
import { ChainError } from '@/lib/chain/errors';
import { ZERO_HASH } from '@/lib/chain/records';
import { registryAbi } from '@/lib/chain/registry-artifact';
import { createFileStore, type FileStore } from '@/lib/file-store';
import { confirmOpinion, createEngagement, uploadVersion } from '@/lib/reports/intake';
import { startAnvil, type AnvilHandle } from '../integration/anvil';

/**
 * The database held to the chain (#111), against a real Postgres and a
 * throwaway Anvil chain. Versions are anchored through the worker, then the
 * database is put back to what a backup taken earlier would hold, while the
 * chain keeps what happened since: every difference is named, and a database
 * that matches the chain reports none.
 */

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
const fixture = (name: string) => fs.readFileSync(path.join(import.meta.dirname, '..', 'fixtures', 'pdf', name));
const h = (label: string): Hex => keccak256(toBytes(label));
const FIRM = 'Example Audit OOD';
const DELAY = 3600;

let anvil: AnvilHandle;
let publicClient: PublicClient;
let secondClient: PublicClient;
let testClient: TestClient;
let issuer: PrivateKeyAccount;
let deployment: Deployment & { deployBlock: number };
let target: AnchorTarget;
let lockClient: pg.Client;
let files: FileStore;
let snapshot: Hex;
let clock: Date;
let orgId: string;
let preparer: SessionUser;
let approver: SessionUser;
let admin: SessionUser;
let refCounter = 0;

const mine = (blocks = 3) => testClient.mine({ blocks });
const pass = () => runWorkerPass({ prisma, lockClient, publicClient, checkClient: secondClient, account: issuer, deployment, files, verifyBaseUrl: 'https://anchor.example.test', now: () => clock, log: () => {} });
const reconcile = (second: PublicClient = secondClient) =>
  reconcileWithChain({ prisma, clients: [publicClient, second], deployment, firm: { orgId, onChainOrgId: orgIdFor(FIRM) }, fromBlock: BigInt(deployment.deployBlock) });
const sorted = (differences: Difference[]) => [...differences].sort((a, b) => a.code.localeCompare(b.code));
const issuerWrite = async (call: { functionName: 'anchor'; args: readonly [Hex, number, Hex, Hex, Hex, Hex] } | { functionName: 'revoke'; args: readonly [Hex, number] }) => {
  const wallet = createWalletClient({ chain: foundry, transport: http(anvil.url), account: issuer });
  const hash = await wallet.writeContract({ address: deployment.address, abi: registryAbi, ...call } as Parameters<typeof wallet.writeContract>[0]);
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
};

async function confirmedVersion(file: string) {
  refCounter += 1;
  const e = await createEngagement(preparer, { clientName: 'Example Manufacturing AD', registrationNumber: '123456789', country: 'BG', engagementRef: `ENG-R-${refCounter}`, periodEnd: '2025-12-31', reportType: 'STANDALONE' });
  const uploaded = await uploadVersion(preparer, { engagementId: e.id, reasonCode: 'INITIAL', bytes: fixture(file) });
  await confirmOpinion(preparer, { versionId: uploaded.id, opinionType: 'UNMODIFIED', text: 'In our opinion, the financial statements present fairly.', reportDate: '2026-03-31' });
  return uploaded.id;
}

/** Approve, then let the worker anchor the original and its stamped copy to COMPLETE. */
async function complete(versionId: string) {
  await approveVersion(approver, versionId, target);
  for (let i = 0; i < 3; i++) {
    await pass();
    await mine();
  }
  await pass();
  const v = await prisma.reportVersion.findUniqueOrThrow({ where: { id: versionId } });
  expect(v.status).toBe('COMPLETE');
  return v;
}

beforeAll(async () => {
  anvil = await startAnvil();
  const transport = http(anvil.url);
  publicClient = createPublicClient({ chain: foundry, transport, pollingInterval: 50 }) as PublicClient;
  // Another client on the same node: every read is still made, and compared, twice (#92).
  secondClient = createPublicClient({ chain: foundry, transport: http(anvil.url), pollingInterval: 50 }) as PublicClient;
  testClient = createTestClient({ chain: foundry, mode: 'anvil', transport });
  issuer = privateKeyToAccount(generatePrivateKey());
  await testClient.setBalance({ address: issuer.address, value: parseEther('10') });
  const [deployer] = await createWalletClient({ chain: foundry, transport }).getAddresses();
  deployment = await deployRegistry({
    publicClient,
    walletClient: createWalletClient({ chain: foundry, transport, account: getAddress(deployer) }),
    issuer: { address: issuer.address, orgId: orgIdFor(FIRM) },
    revocationDelaySeconds: DELAY,
  });
  target = { network: 'local', chainId: 31337, registry: getAddress(deployment.address), issuer: issuer.address };
  await mine();
  lockClient = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await lockClient.connect();
  const key = { key: new Uint8Array(Buffer.from(process.env.FILE_ENCRYPTION_KEY!, 'base64')), version: 1 };
  files = createFileStore({ dir: process.env.FILE_STORAGE_DIR!, current: key, keys: [key] });
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
  await prisma.$executeRawUnsafe('TRUNCATE "Revocation", "ChainWrite", "AuditEvent", "IssuerKeyStatus", "ReportVersion", "StoredFile", "Engagement", "Client", "User", "IssuerOrg" CASCADE');
  orgId = (await prisma.issuerOrg.create({ data: { name: FIRM } })).id;
  const make = async (email: string, role: 'PREPARER' | 'APPROVER' | 'ADMIN'): Promise<SessionUser> => {
    const user = await prisma.user.create({ data: { orgId, email, name: email, role, passwordHash: 'x' } });
    return { id: user.id, email, name: email, role, orgId, mfa: role === 'PREPARER' ? 'NOT_REQUIRED' : 'VERIFIED' };
  };
  preparer = await make('preparer@example.test', 'PREPARER');
  approver = await make('approver@example.test', 'APPROVER');
  admin = await make('admin@example.test', 'ADMIN');
  await setChainWriteMode(approver, 'DRY_RUN');
  await setChainWriteMode(approver, 'LIVE');
});

afterEach(async () => {
  await testClient.revert({ id: snapshot });
});

describe('reconciling the database with the chain (#111)', () => {
  it('finds nothing when they agree, and names everything a backup taken earlier does not know', async () => {
    const v1 = await complete(await confirmedVersion('en-unmodified.pdf'));
    const v2 = await complete(await confirmedVersion('en-qualified.pdf'));
    await mine();
    expect(await reconcile()).toMatchObject({ versions: 2, records: 4, differences: [] });

    // The backup was taken while v1's copy waited to be anchored and v2 waited for the worker.
    await prisma.$executeRawUnsafe(
      `UPDATE "ReportVersion" SET status = 'ANCHORED', "copyRecordId" = NULL, "copyTxHash" = NULL, "copyBlock" = NULL, "completedAt" = NULL WHERE id = '${v1.id}'`,
    );
    await prisma.$executeRawUnsafe(
      `UPDATE "ReportVersion" SET status = 'APPROVED', "recordId" = NULL, "anchorTxHash" = NULL, "anchorBlock" = NULL, "copyDocHash" = NULL, "copyStoredFileId" = NULL, "copyRecordId" = NULL, "copyTxHash" = NULL, "copyBlock" = NULL, "completedAt" = NULL WHERE id = '${v2.id}'`,
    );
    // Since then: a report the database never heard of, and a withdrawal of v1, still in its delay.
    const lostTx = await issuerWrite({ functionName: 'anchor', args: [h('a lost family'), 1, ZERO_HASH, h('a lost report'), h('its manifest'), h('its opinion')] });
    await issuerWrite({ functionName: 'revoke', args: [v1.recordId as Hex, 1] });
    await mine();

    const report = await reconcile();
    expect(report.records).toBe(5);
    const pending = report.differences.find((d) => d.code === 'REVOCATION_PENDING_ON_CHAIN');
    expect(sorted(report.differences)).toEqual([
      { code: 'ANCHORED_AFTER_BACKUP', versionId: v2.id, recordId: v2.recordId },
      { code: 'COPY_ANCHORED_AFTER_BACKUP', versionId: v1.id, recordId: v1.copyRecordId },
      { code: 'REVOCATION_PENDING_ON_CHAIN', versionId: v1.id, reasonCode: 1, effectiveAt: expect.any(Number) },
      // v2's copy: the backup did not know its file.
      expect.objectContaining({ code: 'UNKNOWN_RECORD', recordId: v2.copyRecordId, kind: 'DISTRIBUTION_COPY', docHash: v2.copyDocHash }),
      expect.objectContaining({ code: 'UNKNOWN_RECORD', kind: 'ORIGINAL', docHash: h('a lost report'), txHash: lostTx, issuer: issuer.address }),
    ]);

    // Once the delay has passed, the withdrawal is in effect on chain.
    await testClient.increaseTime({ seconds: DELAY + 60 });
    await mine();
    expect((await reconcile()).differences).toContainEqual({ code: 'REVOKED_ON_CHAIN', versionId: v1.id, reasonCode: 1, effectiveAt: (pending as { effectiveAt: number }).effectiveAt });
  });

  it('names a database that disagrees with the chain about what it anchored', async () => {
    const v1 = await complete(await confirmedVersion('en-unmodified.pdf'));
    const v2 = await confirmedVersion('en-qualified.pdf');
    await mine();
    // v1's manifest hash rewritten; v2 called anchored with a record the chain never held; v1 called revoked; a revocation the chain does not have.
    await prisma.$executeRawUnsafe(`UPDATE "ReportVersion" SET "manifestHash" = '${h('another manifest')}' WHERE id = '${v1.id}'`);
    await prisma.$executeRawUnsafe(
      `UPDATE "ReportVersion" SET status = 'ANCHORED', "approvedById" = '${approver.id}', "approvedAt" = now(), "recordId" = '${h('no such record')}', "anchorBlock" = 1 WHERE id = '${v2}'`,
    );
    const v2Doc = (await prisma.reportVersion.findUniqueOrThrow({ where: { id: v2 } })).docHash;
    const revocation = await prisma.revocation.create({
      data: { reportVersionId: v1.id, reason: 'WITHDRAWN', note: new Uint8Array([1]), status: 'SCHEDULED', requestedById: admin.id, approvedById: approver.id, approvedAt: clock, effectiveAt: clock },
    });

    expect(sorted((await reconcile()).differences)).toEqual([
      { code: 'RECORD_DIFFERS', versionId: v1.id, recordId: v1.recordId, fields: ['manifestHash'] },
      { code: 'RECORD_MISSING', versionId: v2, docHash: v2Doc },
      { code: 'SCHEDULED_NOT_ON_CHAIN', versionId: v1.id, revocationId: revocation.id },
    ]);
    await prisma.$executeRawUnsafe(`UPDATE "ReportVersion" SET status = 'REVOKED', "revokedAt" = now() WHERE id = '${v1.id}'`);
    expect((await reconcile()).differences).toContainEqual({ code: 'REVOKED_NOT_ON_CHAIN', versionId: v1.id });
  });

  it('refuses, rather than answers, when the two endpoints disagree', async () => {
    await complete(await confirmedVersion('en-unmodified.pdf'));
    await mine();
    // A second endpoint that has never seen a log.
    const upstream = http(anvil.url)({ chain: foundry });
    const forgetful = createPublicClient({
      chain: foundry,
      transport: custom({ request: ({ method, params }: { method: string; params?: unknown }) => (method === 'eth_getLogs' ? Promise.resolve([]) : upstream.request({ method, params } as never)) }),
    }) as PublicClient;
    await expect(reconcile(forgetful)).rejects.toMatchObject({ code: 'RPC_DISAGREE' });
    await expect(reconcile(forgetful)).rejects.toBeInstanceOf(ChainError);
  });
});
