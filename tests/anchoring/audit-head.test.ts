import fs from 'node:fs';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  custom,
  encodeFunctionData,
  getAddress,
  http,
  keccak256,
  parseEther,
  toBytes,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
  type TestClient,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import type { SessionUser } from '@/auth';
import { PrismaClient } from '@/generated/prisma/client';
import { setChainWriteMode } from '@/lib/anchoring/approve';
import { registryHeadWitness } from '@/lib/anchoring/audit-head';
import { watchRegistry } from '@/lib/anchoring/registry-watch';
import type { AnchorTarget } from '@/lib/anchoring/target';
import { runWorkerPass } from '@/lib/anchoring/worker';
import { appendAuditEvent } from '@/lib/audit';
import { checkAuditChain, NO_WITNESS } from '@/lib/audit-check';
import { deployRegistry, orgIdFor } from '@/lib/chain/deploy';
import type { Deployment } from '@/lib/chain/deployment';
import { registryAbi } from '@/lib/chain/registry-artifact';
import { createFileStore, type FileStore } from '@/lib/file-store';
import { startAnvil, type AnvilHandle } from '../integration/anvil';

/**
 * The audit log's head on chain (#94), against a real Postgres and a
 * throwaway Anvil chain: the nightly check queues the head, the worker writes
 * it through the journal, and the next check holds the log to it, so a
 * rewrite of both the log and its checks by whoever owns the database is
 * still found. A head a stolen key wrote fails the check and the registry
 * watch reports it, until the registry's owner voids it.
 */

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
const h = (label: string): Hex => keccak256(toBytes(label));
const FIRM = 'Example Audit OOD';

let anvil: AnvilHandle;
let publicClient: PublicClient;
let secondClient: PublicClient;
let testClient: TestClient;
let issuer: PrivateKeyAccount;
let owner: Address;
let deployment: Deployment & { deployBlock: number };
let target: AnchorTarget;
let lockClient: pg.Client;
let files: FileStore;
let snapshot: Hex;
let orgId: string;
let approver: SessionUser;
let clock: Date;

const mine = (blocks = 3) => testClient.mine({ blocks });
const pass = () => runWorkerPass({ prisma, lockClient, publicClient, checkClient: secondClient, account: issuer, deployment, files, verifyBaseUrl: 'https://anchor.example.test', now: () => clock, log: () => {} });
const witness = (second: PublicClient = secondClient) => registryHeadWitness({ clients: [publicClient, second], deployment, target });
const append = (n: number, action: 'engagement.created' | 'version.uploaded' = 'engagement.created') =>
  prisma.$transaction(async (tx) => {
    for (let i = 0; i < n; i++) await appendAuditEvent(tx, { orgId, actorId: null, action, subjectType: 'Engagement', subjectId: `e${i}`, data: { i } });
  });
async function asDatabaseOwner(sql: string) {
  await prisma.$executeRawUnsafe('ALTER TABLE "AuditEvent" DISABLE TRIGGER "AuditEvent_append_only"');
  try {
    await prisma.$executeRawUnsafe(sql);
  } finally {
    await prisma.$executeRawUnsafe('ALTER TABLE "AuditEvent" ENABLE TRIGGER "AuditEvent_append_only"');
  }
}
const headsOnChain = () => publicClient.readContract({ address: deployment.address, abi: registryAbi, functionName: 'auditHeads', args: [orgIdFor(FIRM), 0n, 100n] });
async function sendAs(account: PrivateKeyAccount | Address, call: { functionName: 'recordAuditHead'; args: readonly [Hex] } | { functionName: 'voidAuditHead'; args: readonly [Hex, bigint] }) {
  const wallet = createWalletClient({ chain: foundry, transport: http(anvil.url), account });
  const hash = await wallet.writeContract({ address: deployment.address, abi: registryAbi, ...call } as Parameters<typeof wallet.writeContract>[0]);
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

beforeAll(async () => {
  anvil = await startAnvil();
  const transport = http(anvil.url);
  publicClient = createPublicClient({ chain: foundry, transport, pollingInterval: 50 }) as PublicClient;
  // Another client on the same node: every settling read is still made, and compared, twice (#92).
  secondClient = createPublicClient({ chain: foundry, transport: http(anvil.url), pollingInterval: 50 }) as PublicClient;
  testClient = createTestClient({ chain: foundry, mode: 'anvil', transport });
  issuer = privateKeyToAccount(generatePrivateKey());
  await testClient.setBalance({ address: issuer.address, value: parseEther('10') });
  const [deployer] = await createWalletClient({ chain: foundry, transport }).getAddresses();
  owner = getAddress(deployer);
  deployment = await deployRegistry({ publicClient, walletClient: createWalletClient({ chain: foundry, transport, account: owner }), issuer: { address: issuer.address, orgId: orgIdFor(FIRM) }, revocationDelaySeconds: 3600 });
  target = { network: 'local', chainId: 31337, registry: getAddress(deployment.address), issuer: issuer.address };
  // The registry is read at the finalized block: let its deployment be final, as a real one long is.
  await testClient.mine({ blocks: 3 });
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
  clock = new Date('2026-10-25T02:17:00Z');
  fs.rmSync(process.env.FILE_STORAGE_DIR!, { recursive: true, force: true });
  await prisma.$executeRawUnsafe(
    'TRUNCATE "AuditChainCheck", "UnjournaledWrite", "RegistryWatch", "ChainWrite", "IssuerKeyStatus", "AuditEvent", "User", "IssuerOrg" CASCADE',
  );
  orgId = (await prisma.issuerOrg.create({ data: { name: FIRM } })).id;
  const user = await prisma.user.create({ data: { orgId, email: 'approver@example.test', name: 'Approver', role: 'APPROVER', passwordHash: 'x' } });
  approver = { id: user.id, email: user.email, name: user.name, role: 'APPROVER', orgId, mfa: 'VERIFIED' };
  await setChainWriteMode(approver, 'DRY_RUN');
  await setChainWriteMode(approver, 'LIVE');
});

afterEach(async () => {
  await testClient.revert({ id: snapshot });
});

describe('the audit log’s head on chain (#94)', () => {
  it('is queued by the check, written by the worker through the journal, and holds the log: a rewrite of the log and its checks is found', async () => {
    await append(3);
    const first = await checkAuditChain(prisma, orgId, witness());
    if (!first.ok || !first.queued) throw new Error(`expected a queued head: ${JSON.stringify(first)}`);
    expect(first).toMatchObject({ count: 5, chainHeads: 0 });

    expect((await pass()).steps).toEqual([expect.objectContaining({ writeId: first.queued, from: 'INTENT', to: 'BROADCAST' })]);
    await mine();
    expect((await pass()).steps).toEqual([expect.objectContaining({ writeId: first.queued, from: 'BROADCAST', to: 'FINAL' })]);
    expect(await prisma.chainWrite.findUniqueOrThrow({ where: { id: first.queued } })).toMatchObject({ status: 'FINAL', auditHead: first.head, reportVersionId: null, error: null });
    const onChain = await headsOnChain();
    expect(onChain).toEqual([expect.objectContaining({ head: first.head, issuer: issuer.address, voided: false })]);
    // Its own events carry their own prefix, and count as no news.
    const actions = (await prisma.auditEvent.findMany({ where: { orgId, seq: { gt: 5 } }, orderBy: { seq: 'asc' } })).map((e) => e.action);
    expect(actions).toEqual(['audit_head.queued', 'audit_head.broadcast', 'audit_head.final']);
    await mine();
    // Two mode changes, three events, the head's three: nothing new since the head.
    expect(await checkAuditChain(prisma, orgId, witness())).toMatchObject({ ok: true, count: 8, chainHeads: 1, queued: null });
    // The watch finds the write in the journal.
    expect(await watchRegistry({ prisma, publicClient, deployment, firm: { orgId, onChainOrgId: orgIdFor(FIRM) }, fromBlock: BigInt(deployment.deployBlock) })).toMatchObject({ seen: 1, found: [] });

    // Whoever owns the database rewrites event 2 and re-hashes all after it,
    // and rewrites the checks to match: the database alone now vouches for it.
    await asDatabaseOwner(`DELETE FROM "AuditEvent" WHERE "orgId" = '${orgId}' AND "seq" >= 4`);
    await append(5, 'version.uploaded');
    await prisma.$executeRawUnsafe(`DELETE FROM "AuditChainCheck" WHERE "orgId" = '${orgId}'`);
    expect(await checkAuditChain(prisma, orgId, NO_WITNESS)).toMatchObject({ ok: true, count: 8 });
    // The chain does not.
    expect(await checkAuditChain(prisma, orgId, witness())).toEqual({ ok: false, seq: null, reason: 'ANCHORED_HEAD_MISSING', missing: [0] });
  });

  it('fails the check on a head a stolen key wrote, which the watch reports, until the registry’s owner voids it', async () => {
    await append(2);
    const forged = await sendAs(issuer, { functionName: 'recordAuditHead', args: [h('a head no log of the firm holds')] });
    await mine();
    expect(await checkAuditChain(prisma, orgId, witness())).toEqual({ ok: false, seq: null, reason: 'ANCHORED_HEAD_MISSING', missing: [0] });
    const report = await watchRegistry({ prisma, publicClient, deployment, firm: { orgId, onChainOrgId: orgIdFor(FIRM) }, fromBlock: BigInt(deployment.deployBlock) });
    expect(report.found).toEqual([expect.objectContaining({ kind: 'AUDIT_HEAD', recordId: h('a head no log of the firm holds'), txHash: forged, issuer: issuer.address })]);

    // An issuer key cannot void it; the owner can.
    await expect(sendAs(issuer, { functionName: 'voidAuditHead', args: [orgIdFor(FIRM), 0n] })).rejects.toThrow();
    await sendAs(owner, { functionName: 'voidAuditHead', args: [orgIdFor(FIRM), 0n] });
    await mine();
    // Two mode changes, two events, and the watch's finding.
    expect(await checkAuditChain(prisma, orgId, witness())).toMatchObject({ ok: true, count: 5, chainHeads: 0 });
  });

  it('fails closed when the two endpoints disagree about the heads', async () => {
    await append(1);
    const first = await checkAuditChain(prisma, orgId, witness());
    if (!first.ok || !first.queued) throw new Error(`expected a queued head: ${JSON.stringify(first)}`);
    await pass();
    await mine();
    await pass();
    const before = (await prisma.chainWrite.findUniqueOrThrow({ where: { id: first.queued } })).blockNumber! - 1n;
    // A second endpoint that reads the heads as they were before this one was written.
    const selector = encodeFunctionData({ abi: registryAbi, functionName: 'auditHeads', args: [orgIdFor(FIRM), 0n, 0n] }).slice(0, 10);
    const upstream = http(anvil.url)({ chain: foundry });
    const forgetful = createPublicClient({
      chain: foundry,
      transport: custom({
        request: ({ method, params }: { method: string; params?: unknown }) => {
          const list = (params ?? []) as unknown[];
          const call = list[0] as { data?: string; input?: string } | undefined;
          const data = call?.data ?? call?.input;
          const forwarded = method === 'eth_call' && data?.startsWith(selector) ? [list[0], toHex(before)] : list;
          return upstream.request({ method, params: forwarded } as Parameters<typeof upstream.request>[0]);
        },
      }),
    }) as PublicClient;
    await mine();
    expect(await checkAuditChain(prisma, orgId, witness(forgetful))).toEqual({ ok: false, seq: null, reason: 'CHAIN_UNREADABLE' });
    expect(await checkAuditChain(prisma, orgId, witness())).toMatchObject({ ok: true, chainHeads: 1 });
  });
});
