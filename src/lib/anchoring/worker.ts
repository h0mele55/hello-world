import type { Client as PgClient } from 'pg';
import {
  encodeFunctionData,
  getAddress,
  keccak256,
  parseEther,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  type Address,
  type Hash,
  type Hex,
  type LocalAccount,
  type PublicClient,
  type TransactionReceipt,
} from 'viem';
import { Prisma, type PrismaClient } from '@/generated/prisma/client';
import type { ChainWriteStatus } from '@/generated/prisma/enums';
import { ADVISORY_LOCK_CLASS, appendAuditEvent, type AuditAction } from '@/lib/audit';
import { toRegistryError } from '@/lib/chain/adapter';
import type { Deployment } from '@/lib/chain/deployment';
import { ChainError, RegistryRevertError } from '@/lib/chain/errors';
import { createRegistryReader, type RegistryReader } from '@/lib/chain/reader';
import { recordIdFor, ZERO_HASH, type RegistryRecord } from '@/lib/chain/records';
import { registryAbi } from '@/lib/chain/registry-artifact';
import { rungOf } from './ladder';
import { classifySendError, type SendOutcome } from './send';

/**
 * The anchoring worker: the only code that signs and sends a transaction for
 * the app. It works the ChainWrite journal one step at a time:
 *
 *   INTENT ──sign, journal nonce + hash, send──▶ BROADCAST ──finalized──▶ FINAL
 *     │  (DRY_RUN: simulate only) ──▶ SIMULATED                │
 *     │                                                       ├─reverted──▶ FAILED
 *     └─ refused before signing ──▶ FAILED                     └─pending 10 min──▶ replaced, same nonce
 *
 * A send whose outcome is unknown, or a crash between journalling the hash and
 * learning the outcome, makes the row INDETERMINATE. An INDETERMINATE row is
 * never resent; it is settled by reading the chain (receipts for every hash it
 * had, the node's pool, the record for its document, and the issuer's
 * finalized nonce), and while one is unsettled no new LIVE write starts for
 * that issuer key, because its next nonce is unknown.
 *
 * One worker per issuer key holds a Postgres session advisory lock for the
 * whole pass, on a dedicated connection, so nonces are assigned by one writer.
 * A partial unique index on (chainId, issuer, nonce) backs that up: a second
 * writer that picked the same nonce cannot journal it, so never sends it.
 *
 * A row keeps its nonce while its transaction may still land, or once its own
 * transaction used it. When the nonce was never used by this row's
 * transaction (refused by the node, or used by another), the nonce is cleared
 * so it can be assigned again.
 */

export interface WorkerOptions {
  /** How long a claimed row is held. A row whose lease ran out belonged to a worker that died mid-step. */
  leaseMs: number;
  /** A broadcast transaction still pending after this long is replaced at the same nonce. */
  replaceAfterMs: number;
  /** How much a replacement raises both fee caps, in percent. */
  feeBumpPercent: number;
  /** Headroom over the gas estimate, in percent. */
  gasHeadroomPercent: number;
  /** Below this balance the pass reports the issuer key as low. */
  lowBalanceWei: bigint;
}

export const DEFAULT_WORKER_OPTIONS: WorkerOptions = {
  leaseMs: 120_000,
  replaceAfterMs: 10 * 60_000,
  feeBumpPercent: 20,
  gasHeadroomPercent: 20,
  lowBalanceWei: parseEther('0.02'),
};

/**
 * Test seams. A throw from one behaves like the process dying at that point:
 * the step stops, nothing after it runs, and the row keeps its lease.
 */
export interface WorkerFaults {
  afterBuild?(writeId: string): Promise<void>;
  beforeSend?(writeId: string): Promise<void>;
  afterSend?(writeId: string): Promise<void>;
}

export type WorkerLog = (level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void;

export interface WorkerDeps {
  prisma: PrismaClient;
  /** A dedicated session for the issuer's advisory lock; never a pooled connection. */
  lockClient: PgClient;
  publicClient: PublicClient;
  /** The issuer key. */
  account: LocalAccount;
  deployment: Deployment;
  now?: () => Date;
  options?: Partial<WorkerOptions>;
  faults?: WorkerFaults;
  log?: WorkerLog;
}

export interface StepReport {
  writeId: string;
  from: ChainWriteStatus;
  to: ChainWriteStatus;
  note?: string;
}

export interface PassReport {
  ran: boolean;
  reason?: 'ISSUER_LOCKED' | 'DEPLOYMENT_MISMATCH';
  balanceWei?: bigint;
  lowBalance?: boolean;
  steps: StepReport[];
  /** Steps that threw. Their rows keep their lease and are retried once it runs out. */
  errors: { writeId: string; error: string }[];
}

const writeInclude = {
  reportVersion: { include: { engagement: { include: { client: { include: { org: { select: { chainWriteMode: true } } } } } } } },
} satisfies Prisma.ChainWriteInclude;

type Write = Prisma.ChainWriteGetPayload<{ include: typeof writeInclude }>;

interface Context {
  prisma: PrismaClient;
  publicClient: PublicClient;
  reader: RegistryReader;
  account: LocalAccount;
  chainId: number;
  registry: Address;
  issuer: Address;
  now: () => Date;
  options: WorkerOptions;
  faults: WorkerFaults;
  log: WorkerLog;
}

const defaultLog: WorkerLog = (level, message, fields) => {
  const line = JSON.stringify({ level, message, ...fields }, (_, value) => (typeof value === 'bigint' ? value.toString() : value));
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
};

/** A name for an error, never its message: a message can carry request bodies. */
export function errorName(error: unknown): string {
  if (error instanceof RegistryRevertError) return error.errorName;
  if (error instanceof ChainError) return error.code;
  return error instanceof Error ? error.name : typeof error;
}

const issuerLockKey = (chainId: number, issuer: Address) => `${chainId}:${issuer.toLowerCase()}`;

export async function runWorkerPass(deps: WorkerDeps): Promise<PassReport> {
  const ctx: Context = {
    prisma: deps.prisma,
    publicClient: deps.publicClient,
    reader: createRegistryReader(deps.publicClient, deps.deployment),
    account: deps.account,
    chainId: deps.deployment.chainId,
    registry: getAddress(deps.deployment.address),
    issuer: deps.account.address,
    now: deps.now ?? (() => new Date()),
    options: { ...DEFAULT_WORKER_OPTIONS, ...deps.options },
    faults: deps.faults ?? {},
    log: deps.log ?? defaultLog,
  };
  const report: PassReport = { ran: false, steps: [], errors: [] };
  const lockArgs = [ADVISORY_LOCK_CLASS.ISSUER_KEY, issuerLockKey(ctx.chainId, ctx.issuer)];
  const { rows } = await deps.lockClient.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1::int, hashtext($2)) AS locked', lockArgs);
  if (!rows[0]?.locked) return { ...report, reason: 'ISSUER_LOCKED' };
  try {
    try {
      await ctx.reader.assertDeployment();
    } catch (error) {
      if (!(error instanceof ChainError)) throw error;
      ctx.log('error', 'refusing to work: the chain does not hold the expected registry', { code: error.code, registry: ctx.registry, chainId: ctx.chainId });
      return { ...report, reason: 'DEPLOYMENT_MISMATCH' };
    }
    report.ran = true;
    const balance = await checkBalance(ctx);
    report.balanceWei = balance.wei;
    report.lowBalance = balance.low;

    const done: string[] = [];
    for (;;) {
      const id = await claim(ctx, done);
      if (!id) break;
      done.push(id);
      try {
        const step = await stepWrite(ctx, id);
        report.steps.push(step);
        ctx.log('info', 'step', { ...step });
      } catch (error) {
        report.errors.push({ writeId: id, error: errorName(error) });
        ctx.log('error', 'step failed; the row is retried when its lease runs out', { writeId: id, error: errorName(error) });
      }
    }
    return report;
  } finally {
    await deps.lockClient.query('SELECT pg_advisory_unlock($1::int, hashtext($2))', lockArgs);
  }
}

async function checkBalance(ctx: Context): Promise<{ wei: bigint; low: boolean }> {
  const wei = await ctx.publicClient.getBalance({ address: ctx.issuer });
  const low = wei < ctx.options.lowBalanceWei;
  const checkedAt = ctx.now();
  await ctx.prisma.issuerKeyStatus.upsert({
    where: { chainId_address: { chainId: ctx.chainId, address: ctx.issuer } },
    create: { chainId: ctx.chainId, address: ctx.issuer, balanceWei: wei.toString(), low, checkedAt },
    update: { balanceWei: wei.toString(), low, checkedAt },
  });
  if (low) ctx.log('error', 'issuer balance is below the alert threshold', { issuer: ctx.issuer, balanceWei: wei, thresholdWei: ctx.options.lowBalanceWei });
  return { wei, low };
}

/**
 * Takes the next workable row of this issuer: settling INDETERMINATE rows
 * first, then tracking broadcasts, then starting new writes. Each row is
 * stepped at most once per pass.
 */
async function claim(ctx: Context, done: string[]): Promise<string | null> {
  const now = ctx.now();
  const leaseUntil = new Date(now.getTime() + ctx.options.leaseMs);
  const rows = await ctx.prisma.$queryRaw<{ id: string }[]>`
    UPDATE "ChainWrite" SET "leaseUntil" = ${leaseUntil}, "attempts" = "attempts" + 1, "updatedAt" = ${now}
    WHERE "id" = (
      SELECT "id" FROM "ChainWrite"
      WHERE "chainId" = ${ctx.chainId} AND "registry" = ${ctx.registry} AND "issuer" = ${ctx.issuer}
        AND "status" IN ('INTENT', 'BROADCAST', 'INDETERMINATE')
        AND ("leaseUntil" IS NULL OR "leaseUntil" < ${now})
        AND NOT ("id" = ANY(${done}::text[]))
      ORDER BY CASE "status" WHEN 'INDETERMINATE' THEN 0 WHEN 'BROADCAST' THEN 1 ELSE 2 END, "createdAt"
      LIMIT 1
      FOR UPDATE SKIP LOCKED)
    RETURNING "id"`;
  return rows[0]?.id ?? null;
}

async function stepWrite(ctx: Context, id: string): Promise<StepReport> {
  const write = await ctx.prisma.chainWrite.findUniqueOrThrow({ where: { id }, include: writeInclude });
  switch (write.status) {
    case 'INTENT':
      // A hash was journalled but the step never learnt what the send did.
      if (write.txHash) return indeterminate(ctx, write, 'SEND_OUTCOME_UNKNOWN');
      return startWrite(ctx, write);
    case 'BROADCAST':
      return trackBroadcast(ctx, write);
    case 'INDETERMINATE':
      return reconcile(ctx, write);
    default:
      return release(ctx, write, {}, 'not workable');
  }
}

// ── Transitions: each is one transaction, conditional on the row being as read ──

interface Effects {
  version?: 'REVERT_TO_CONFIRMED' | { recordId: string; txHash: string | null; blockNumber: bigint };
  audit?: { action: AuditAction; data: Record<string, unknown> };
}

async function transition(
  ctx: Context,
  write: Write,
  to: ChainWriteStatus,
  data: Prisma.ChainWriteUpdateManyMutationInput,
  effects: Effects,
  note?: string,
): Promise<StepReport> {
  const moved = await ctx.prisma.$transaction(async (tx) => {
    const { count } = await tx.chainWrite.updateMany({
      where: { id: write.id, status: write.status, txHash: write.txHash },
      data: { ...data, status: to, leaseUntil: null },
    });
    if (count !== 1) return false;
    const version = write.reportVersion;
    if (effects.version === 'REVERT_TO_CONFIRMED') {
      // The approval was for this write; a new attempt needs a new approval.
      await tx.reportVersion.updateMany({ where: { id: version.id, status: 'APPROVED' }, data: { status: 'CONFIRMED', approvedById: null, approvedAt: null } });
    } else if (effects.version) {
      const anchored = await tx.reportVersion.updateMany({
        where: { id: version.id, status: 'APPROVED' },
        data: { status: 'ANCHORED', recordId: effects.version.recordId, anchorTxHash: effects.version.txHash, anchorBlock: effects.version.blockNumber },
      });
      if (anchored.count !== 1) throw new ChainError('VERSION_NOT_APPROVED', `version ${version.id} is not APPROVED`);
    }
    if (effects.audit) {
      await appendAuditEvent(
        tx,
        {
          orgId: version.engagement.client.orgId,
          actorId: null,
          action: effects.audit.action,
          subjectType: 'ChainWrite',
          subjectId: write.id,
          data: { reportVersionId: version.id, kind: write.kind, mode: write.mode, ...effects.audit.data },
        },
        ctx.now(),
      );
    }
    return true;
  });
  if (!moved) return { writeId: write.id, from: write.status, to: write.status, note: 'changed by another writer; left alone' };
  return { writeId: write.id, from: write.status, to, note };
}

/** Lets go of the row without changing its status. */
async function release(ctx: Context, write: Write, data: Prisma.ChainWriteUpdateManyMutationInput, note: string): Promise<StepReport> {
  await ctx.prisma.chainWrite.updateMany({ where: { id: write.id, status: write.status, txHash: write.txHash }, data: { ...data, leaseUntil: null } });
  return { writeId: write.id, from: write.status, to: write.status, note };
}

function fail(ctx: Context, write: Write, reason: string, data: Prisma.ChainWriteUpdateManyMutationInput = {}) {
  return transition(ctx, write, 'FAILED', { ...data, error: reason }, {
    version: 'REVERT_TO_CONFIRMED',
    audit: { action: 'anchor.failed', data: { reason, txHash: (data.txHash as string | undefined) ?? write.txHash } },
  }, reason);
}

function indeterminate(ctx: Context, write: Write, reason: string, data: Prisma.ChainWriteUpdateManyMutationInput = {}) {
  ctx.log('warn', 'write is INDETERMINATE; it will be settled from chain state, never resent', { writeId: write.id, reason });
  return transition(ctx, write, 'INDETERMINATE', { ...data, error: reason }, {
    audit: { action: 'anchor.indeterminate', data: { reason, txHash: write.txHash, nonce: write.nonce } },
  }, reason);
}

function simulated(ctx: Context, write: Write, outcome: string | null) {
  return transition(ctx, write, 'SIMULATED', { error: outcome }, {
    version: 'REVERT_TO_CONFIRMED',
    audit: { action: 'anchor.simulated', data: { outcome: outcome ?? 'WOULD_SUCCEED' } },
  }, outcome ?? 'would succeed');
}

function finalize(ctx: Context, write: Write, final: { txHash: string | null; blockNumber: bigint; recordId: string; linked: boolean; data?: Prisma.ChainWriteUpdateManyMutationInput }) {
  return transition(ctx, write, 'FINAL', { ...final.data, txHash: final.txHash, blockNumber: final.blockNumber, recordId: final.recordId, error: null }, {
    version: { recordId: final.recordId, txHash: final.txHash, blockNumber: final.blockNumber },
    audit: { action: final.linked ? 'anchor.linked' : 'anchor.final', data: { recordId: final.recordId, txHash: final.txHash, blockNumber: Number(final.blockNumber) } },
  });
}

// ── INTENT: build, check, simulate, then sign and send ──

function anchorArgs(write: Write, parentId: string) {
  const version = write.reportVersion;
  return [
    version.engagement.familyId as Hex,
    version.version,
    parentId as Hex,
    version.docHash as Hex,
    version.manifestHash as Hex,
    version.opinionCommitment as Hex,
  ] as const;
}

async function issuerBlocked(ctx: Context): Promise<boolean> {
  const count = await ctx.prisma.chainWrite.count({ where: { chainId: ctx.chainId, issuer: ctx.issuer, status: 'INDETERMINATE' } });
  return count > 0;
}

async function startWrite(ctx: Context, write: Write): Promise<StepReport> {
  const version = write.reportVersion;
  const orgMode = version.engagement.client.org.chainWriteMode;
  // The brake: a write approved under a wider mode does not start once narrowed.
  if (orgMode === 'DISABLED' || rungOf(orgMode) < rungOf(write.mode)) return fail(ctx, write, 'MODE_NARROWED');
  if (version.status !== 'APPROVED' || !version.manifestHash || !version.opinionCommitment) return fail(ctx, write, 'VERSION_NOT_APPROVED');
  const live = write.mode === 'LIVE';
  if (live && (await issuerBlocked(ctx))) {
    return release(ctx, write, { error: 'ISSUER_BLOCKED' }, 'waiting: an INDETERMINATE write must be settled first');
  }

  // Idempotency: a document already on chain is linked, never sent again.
  if (live) {
    const existing = await ctx.reader.findByDocHash(version.docHash as Hex);
    if (existing) return linkExisting(ctx, write, existing);
  }

  // Parent = the family's latest, which must be the version before this one.
  const familyId = version.engagement.familyId as Hex;
  const latest = await ctx.reader.latestOf(familyId);
  let expected: string | null = null;
  if (version.version > 1) {
    const predecessor = await ctx.prisma.reportVersion.findUnique({
      where: { engagementId_version: { engagementId: version.engagementId, version: version.version - 1 } },
      select: { recordId: true },
    });
    if (!predecessor?.recordId) return live ? fail(ctx, write, 'PREDECESSOR_NOT_ANCHORED') : simulated(ctx, write, 'PREDECESSOR_NOT_ANCHORED');
    expected = predecessor.recordId;
  }
  if ((latest?.recordId ?? null) !== expected) {
    return live ? fail(ctx, write, 'FAMILY_LATEST_MISMATCH') : simulated(ctx, write, 'FAMILY_LATEST_MISMATCH');
  }
  const parentId = latest?.recordId ?? ZERO_HASH;
  const recordId = recordIdFor(ctx.chainId, ctx.registry, familyId, version.version, 'ORIGINAL');
  const built = await ctx.prisma.chainWrite.updateMany({ where: { id: write.id, status: 'INTENT', txHash: null }, data: { parentId, recordId, error: null } });
  if (built.count !== 1) return { writeId: write.id, from: 'INTENT', to: 'INTENT', note: 'changed by another writer; left alone' };
  const current: Write = { ...write, parentId, recordId, error: null };
  await ctx.faults.afterBuild?.(write.id);

  const args = anchorArgs(current, parentId);
  try {
    await ctx.publicClient.simulateContract({ address: ctx.registry, abi: registryAbi, functionName: 'anchor', args, account: ctx.issuer });
  } catch (error) {
    const named = toRegistryError(error);
    if (named instanceof RegistryRevertError) return live ? fail(ctx, current, named.errorName) : simulated(ctx, current, named.errorName);
    throw named;
  }
  if (!live) return simulated(ctx, current, null);
  return signAndSend(ctx, current, args);
}

function recordIsThisVersion(record: RegistryRecord, write: Write): boolean {
  const version = write.reportVersion;
  return (
    record.kind === 'ORIGINAL' &&
    record.familyId === version.engagement.familyId &&
    record.version === version.version &&
    record.docHash === version.docHash &&
    record.manifestHash === version.manifestHash &&
    record.opinionCommitment === version.opinionCommitment
  );
}

/** The transaction that created a record, found by its Anchored event. */
async function anchoringTxOf(ctx: Context, record: RegistryRecord): Promise<Hash | null> {
  const block = BigInt(record.blockNumber);
  const events = await ctx.publicClient.getContractEvents({
    address: ctx.registry,
    abi: registryAbi,
    eventName: 'Anchored',
    args: { recordId: record.recordId },
    fromBlock: block,
    toBlock: block,
  });
  return events[0]?.transactionHash ?? null;
}

/** The document is already anchored as this version: settle on that record, sending nothing. */
async function linkExisting(ctx: Context, write: Write, record: RegistryRecord): Promise<StepReport> {
  if (!recordIsThisVersion(record, write)) return fail(ctx, write, 'DOC_ANCHORED_ELSEWHERE');
  const finalized = await ctx.publicClient.getBlock({ blockTag: 'finalized' });
  if (finalized.number < BigInt(record.blockNumber)) {
    return release(ctx, write, { recordId: record.recordId, parentId: record.parentId }, 'already on chain; waiting for finality');
  }
  const txHash = await anchoringTxOf(ctx, record);
  if (!txHash) ctx.log('warn', 'record is final but its Anchored event was not found', { writeId: write.id, recordId: record.recordId });
  return finalize(ctx, write, { txHash, blockNumber: BigInt(record.blockNumber), recordId: record.recordId, linked: true, data: { parentId: record.parentId, nonce: null } });
}

async function nextNonce(ctx: Context): Promise<number> {
  const [pending, live] = await Promise.all([
    ctx.publicClient.getTransactionCount({ address: ctx.issuer, blockTag: 'pending' }),
    // Rows whose transaction may still land: the node may not show them as pending.
    ctx.prisma.chainWrite.aggregate({
      where: { chainId: ctx.chainId, issuer: ctx.issuer, nonce: { not: null }, status: { in: ['INTENT', 'BROADCAST', 'INDETERMINATE'] } },
      _max: { nonce: true },
    }),
  ]);
  return Math.max(pending, (live._max.nonce ?? -1) + 1);
}

const isUniqueViolation = (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

async function send(ctx: Context, serializedTransaction: Hex): Promise<SendOutcome> {
  try {
    await ctx.publicClient.sendRawTransaction({ serializedTransaction });
    return { kind: 'SENT' };
  } catch (error) {
    return classifySendError(error);
  }
}

async function signAndSend(ctx: Context, write: Write, args: ReturnType<typeof anchorArgs>): Promise<StepReport> {
  const [nonce, gasEstimate, fees] = await Promise.all([
    nextNonce(ctx),
    ctx.publicClient.estimateContractGas({ address: ctx.registry, abi: registryAbi, functionName: 'anchor', args, account: ctx.issuer }),
    ctx.publicClient.estimateFeesPerGas(),
  ]);
  const gas = (gasEstimate * BigInt(100 + ctx.options.gasHeadroomPercent)) / 100n;
  const serialized = await ctx.account.signTransaction({
    chainId: ctx.chainId,
    type: 'eip1559',
    to: ctx.registry,
    data: encodeFunctionData({ abi: registryAbi, functionName: 'anchor', args }),
    nonce,
    gas,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  });
  const txHash = keccak256(serialized);

  // Rule 3: the nonce and hash are journalled before the bytes leave.
  try {
    const journalled = await ctx.prisma.chainWrite.updateMany({
      where: { id: write.id, status: 'INTENT', txHash: null },
      data: { nonce, txHash, gasLimit: gas.toString(), maxFeePerGas: fees.maxFeePerGas.toString(), maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString() },
    });
    if (journalled.count !== 1) return { writeId: write.id, from: 'INTENT', to: 'INTENT', note: 'changed by another writer; left alone' };
  } catch (error) {
    if (isUniqueViolation(error)) return release(ctx, write, {}, `nonce ${nonce} is journalled by another write; retrying next pass`);
    throw error;
  }
  const sent: Write = { ...write, nonce, txHash };
  await ctx.faults.beforeSend?.(write.id);
  const outcome = await send(ctx, serialized);
  await ctx.faults.afterSend?.(write.id);

  switch (outcome.kind) {
    case 'SENT':
      return transition(ctx, sent, 'BROADCAST', { broadcastAt: ctx.now(), error: null }, { audit: { action: 'anchor.broadcast', data: { txHash, nonce } } });
    case 'REJECTED':
      // The node refused the bytes: this nonce was not used, so give it back.
      return fail(ctx, sent, `SEND_REJECTED:${outcome.reason}`, { nonce: null });
    case 'UNKNOWN':
      return indeterminate(ctx, sent, outcome.reason, { broadcastAt: ctx.now() });
  }
}

// ── BROADCAST: wait for finality, replace when stuck ──

async function receiptOf(ctx: Context, hash: Hash): Promise<TransactionReceipt | null> {
  try {
    return await ctx.publicClient.getTransactionReceipt({ hash });
  } catch (error) {
    if (error instanceof TransactionReceiptNotFoundError) return null;
    throw error;
  }
}

async function firstReceipt(ctx: Context, hashes: Hash[]): Promise<TransactionReceipt | null> {
  for (const hash of hashes) {
    const receipt = await receiptOf(ctx, hash);
    if (receipt) return receipt;
  }
  return null;
}

/** Whether the node knows any of the hashes, mined or still in its pool. */
async function anyKnown(ctx: Context, hashes: Hash[]): Promise<boolean> {
  for (const hash of hashes) {
    try {
      await ctx.publicClient.getTransaction({ hash });
      return true;
    } catch (error) {
      if (!(error instanceof TransactionNotFoundError)) throw error;
    }
  }
  return false;
}

const hashesOf = (write: Write) => [write.txHash, ...write.replacedTxHashes].filter((h): h is string => !!h) as Hash[];

function recordMatches(record: RegistryRecord | null, write: Write, issuer: Address, blockNumber: bigint): boolean {
  return (
    record !== null &&
    recordIsThisVersion(record, write) &&
    record.recordId === write.recordId &&
    record.parentId === write.parentId &&
    getAddress(record.issuer) === issuer &&
    BigInt(record.blockNumber) === blockNumber
  );
}

async function trackBroadcast(ctx: Context, write: Write): Promise<StepReport> {
  const hashes = hashesOf(write);
  const receipt = await firstReceipt(ctx, hashes);
  if (!receipt) {
    if (!(await anyKnown(ctx, hashes))) return indeterminate(ctx, write, 'TX_NOT_FOUND');
    const pendingFor = ctx.now().getTime() - (write.broadcastAt ?? ctx.now()).getTime();
    if (pendingFor >= ctx.options.replaceAfterMs) return replace(ctx, write);
    return release(ctx, write, {}, 'pending');
  }

  const landed = receipt.transactionHash;
  const settled = { txHash: landed, replacedTxHashes: hashes.filter((h) => h !== landed), blockNumber: receipt.blockNumber };
  // A reverted transaction still used its nonce, so the row keeps it.
  if (receipt.status !== 'success') return fail(ctx, write, 'TX_REVERTED', settled);

  const finalized = await ctx.publicClient.getBlock({ blockTag: 'finalized' });
  if (finalized.number < receipt.blockNumber) return release(ctx, write, settled, `in block ${receipt.blockNumber}; waiting for finality`);
  // Read again after finality: a receipt seen before a reorg may name another block.
  const again = await receiptOf(ctx, landed);
  if (!again || again.blockHash !== receipt.blockHash) return release(ctx, write, {}, 'block changed; checking again next pass');

  const record = write.recordId ? await ctx.reader.getRecord(write.recordId as Hex) : null;
  if (!recordMatches(record, write, ctx.issuer, receipt.blockNumber)) return indeterminate(ctx, write, 'RECORD_MISMATCH', settled);
  return finalize(ctx, write, { txHash: landed, blockNumber: receipt.blockNumber, recordId: write.recordId!, linked: false, data: { replacedTxHashes: settled.replacedTxHashes } });
}

/** The same call at the same nonce with both fee caps raised: only one of the two can ever be mined. */
async function replace(ctx: Context, write: Write): Promise<StepReport> {
  if (write.nonce === null || !write.txHash || !write.parentId || !write.gasLimit || !write.maxFeePerGas || !write.maxPriorityFeePerGas) {
    return indeterminate(ctx, write, 'CANNOT_REPLACE');
  }
  const fees = await ctx.publicClient.estimateFeesPerGas();
  const bump = (value: bigint) => (value * BigInt(100 + ctx.options.feeBumpPercent) + 99n) / 100n;
  const max = (...values: bigint[]) => values.reduce((a, b) => (a > b ? a : b));
  const maxPriorityFeePerGas = max(bump(BigInt(write.maxPriorityFeePerGas)), fees.maxPriorityFeePerGas);
  const maxFeePerGas = max(bump(BigInt(write.maxFeePerGas)), fees.maxFeePerGas, maxPriorityFeePerGas);
  const serialized = await ctx.account.signTransaction({
    chainId: ctx.chainId,
    type: 'eip1559',
    to: ctx.registry,
    data: encodeFunctionData({ abi: registryAbi, functionName: 'anchor', args: anchorArgs(write, write.parentId) }),
    nonce: write.nonce,
    gas: BigInt(write.gasLimit),
    maxFeePerGas,
    maxPriorityFeePerGas,
  });
  const txHash = keccak256(serialized);
  const now = ctx.now();
  const journalled = await ctx.prisma.chainWrite.updateMany({
    where: { id: write.id, status: 'BROADCAST', txHash: write.txHash },
    data: {
      txHash,
      replacedTxHashes: [...write.replacedTxHashes, write.txHash],
      maxFeePerGas: maxFeePerGas.toString(),
      maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
      broadcastAt: now,
    },
  });
  if (journalled.count !== 1) return { writeId: write.id, from: 'BROADCAST', to: 'BROADCAST', note: 'changed by another writer; left alone' };
  const replacing: Write = { ...write, txHash, replacedTxHashes: [...write.replacedTxHashes, write.txHash], broadcastAt: now };
  const outcome = await send(ctx, serialized);
  switch (outcome.kind) {
    case 'SENT':
      return transition(ctx, replacing, 'BROADCAST', { error: null }, {
        audit: { action: 'anchor.replaced', data: { from: write.txHash, to: txHash, nonce: write.nonce } },
      }, `replaced at nonce ${write.nonce}`);
    case 'REJECTED':
      // The original is still the live transaction; try again after another window.
      return release(ctx, replacing, {
        txHash: write.txHash,
        replacedTxHashes: write.replacedTxHashes,
        maxFeePerGas: write.maxFeePerGas,
        maxPriorityFeePerGas: write.maxPriorityFeePerGas,
        error: `REPLACEMENT_REJECTED:${outcome.reason}`,
      }, `replacement refused: ${outcome.reason}`);
    case 'UNKNOWN':
      return indeterminate(ctx, replacing, outcome.reason);
  }
}

// ── INDETERMINATE: settle from chain state only ──

async function reconcile(ctx: Context, write: Write): Promise<StepReport> {
  if (write.nonce === null || !write.txHash) return release(ctx, write, {}, 'nothing to reconcile');
  // A record that does not match what was sent needs a person, not another loop.
  if (write.error === 'RECORD_MISMATCH') return release(ctx, write, {}, 'held for a person: the record does not match the write');
  // Read the finalized nonce before the receipts: a transaction mined in
  // between then shows up as a receipt rather than as someone else's nonce.
  const finalizedNonce = await ctx.publicClient.getTransactionCount({ address: ctx.issuer, blockTag: 'finalized' });
  const hashes = hashesOf(write);
  if ((await firstReceipt(ctx, hashes)) || (await anyKnown(ctx, hashes))) {
    // It was sent: track it like any broadcast.
    return transition(ctx, write, 'BROADCAST', { broadcastAt: write.broadcastAt ?? ctx.now(), error: null }, {
      audit: { action: 'anchor.broadcast', data: { txHash: write.txHash, nonce: write.nonce, reconciled: true } },
    }, 'found on chain');
  }
  if (finalizedNonce > write.nonce) {
    // Another transaction used this nonce, so ours can never be mined.
    const record = await ctx.reader.findByDocHash(write.reportVersion.docHash as Hex);
    if (record && recordIsThisVersion(record, write)) {
      const txHash = await anchoringTxOf(ctx, record);
      return finalize(ctx, write, { txHash, blockNumber: BigInt(record.blockNumber), recordId: record.recordId, linked: true, data: { nonce: null } });
    }
    return fail(ctx, write, 'NONCE_CONSUMED', { nonce: null });
  }
  // Not mined, not pending, nonce unused: the outcome cannot be read yet.
  ctx.log('error', 'INDETERMINATE write cannot be settled from chain state; the issuer key is held until it is', {
    writeId: write.id,
    nonce: write.nonce,
    finalizedNonce,
  });
  return release(ctx, write, {}, 'unsettled: transaction unknown and its nonce unused');
}
