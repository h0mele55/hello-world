import type { Client as PgClient } from 'pg';
import {
  encodeFunctionData,
  getAddress,
  keccak256,
  parseEther,
  type Address,
  type Hash,
  type Hex,
  type LocalAccount,
  type PublicClient,
} from 'viem';
import { Prisma, type PrismaClient } from '@/generated/prisma/client';
import type { ChainWriteStatus } from '@/generated/prisma/enums';
import { appendAuditEvent, type AuditAction } from '@/lib/audit';
import { toRegistryError } from '@/lib/chain/adapter';
import type { Deployment } from '@/lib/chain/deployment';
import { ChainError, RegistryRevertError } from '@/lib/chain/errors';
import { createRegistryReader, type RegistryReader } from '@/lib/chain/reader';
import { recordIdFor, ZERO_HASH, type RegistryRecord } from '@/lib/chain/records';
import { registryAbi } from '@/lib/chain/registry-artifact';
import { certificatePdf } from '@/lib/certificate';
import { docHashOf } from '@/lib/commitments';
import { explorerTxUrl, networkNameOf } from '@/lib/chain/explorer';
import type { FileStore } from '@/lib/file-store';
import { NORMALISER_VERSION } from '@/lib/opinion/normalise';
import { REVOCATION_CODES } from '@/lib/revocation-reasons';
import { checkStampedCopy, stampPdf, StampError } from '@/lib/stamp';
import { STAMP_VERSION, type StampFields } from '@/lib/stamp-fields';
import { anyKnown, firstReceipt, hashesOfWrite, issuerLockArgs, receiptOf } from './chain-reads';
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
 *
 * Two kinds of write. ANCHOR records an original; when it is FINAL the version
 * is ANCHORED and, unless it is anchor-only, an ANCHOR_COPY is queued in the
 * same transaction. ANCHOR_COPY first stamps the original (src/lib/stamp.ts),
 * re-reads and checks the stamped copy, stores it encrypted, and then anchors
 * it as the original's DISTRIBUTION_COPY; when that is FINAL the version is
 * COMPLETE. An anchor-only version (signed or edit-protected, never rewritten)
 * gets a verification certificate instead, after its ANCHOR is FINAL.
 *
 * REVOKE withdraws a version's original record, with the reason of the
 * revocation an approver approved (src/lib/anchoring/revocation.ts). When it
 * is FINAL, and the record reads revoked with that reason, the version and
 * the revocation are REVOKED. A failed or simulated REVOKE returns the
 * revocation for approval, as a failed ANCHOR returns its version.
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
  /** Where originals are read from and copies and certificates are written to, encrypted. */
  files: FileStore;
  /** The app's public origin; stamps and certificates point at `${verifyBaseUrl}/verify`. */
  verifyBaseUrl: string;
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
  /** Anchor-only versions made COMPLETE with a certificate in this pass. */
  certified: string[];
}

const writeInclude = {
  reportVersion: {
    include: {
      storedFile: true,
      engagement: { include: { client: { include: { org: { select: { chainWriteMode: true } } } } } },
      // The approved revocation a REVOKE write carries out: its reason is what goes on chain.
      revocations: { where: { status: 'APPROVED' }, select: { id: true, reason: true }, take: 1 },
    },
  },
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
  files: FileStore;
  verifyUrl: string;
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
    files: deps.files,
    verifyUrl: `${deps.verifyBaseUrl.replace(/\/+$/, '')}/verify`,
  };
  const report: PassReport = { ran: false, steps: [], errors: [], certified: [] };
  const lockArgs = issuerLockArgs(ctx.chainId, ctx.issuer);
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
    await certifyAnchorOnly(ctx, report);
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

type VersionEffect =
  /** The approval was for this ANCHOR; a new attempt needs a new approval. */
  | { kind: 'REVERT_TO_CONFIRMED' }
  /** The original is final; queue its distribution copy unless it is anchor-only. */
  | { kind: 'ANCHORED'; recordId: string; txHash: string | null; blockNumber: bigint }
  /** The distribution copy is final. */
  | { kind: 'COMPLETE'; recordId: string; txHash: string | null; blockNumber: bigint }
  /** The approval was for this REVOKE; a new attempt needs a new approval. */
  | { kind: 'REVERT_REVOCATION' }
  /** The revocation is final. */
  | { kind: 'REVOKED' };

interface Effects {
  version?: VersionEffect;
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
    const effect = effects.version;
    if (effect?.kind === 'REVERT_TO_CONFIRMED') {
      await tx.reportVersion.updateMany({ where: { id: version.id, status: 'APPROVED' }, data: { status: 'CONFIRMED', approvedById: null, approvedAt: null } });
    } else if (effect?.kind === 'ANCHORED') {
      const anchored = await tx.reportVersion.updateMany({
        where: { id: version.id, status: 'APPROVED' },
        data: { status: 'ANCHORED', recordId: effect.recordId, anchorTxHash: effect.txHash, anchorBlock: effect.blockNumber },
      });
      if (anchored.count !== 1) throw new ChainError('VERSION_NOT_APPROVED', `version ${version.id} is not APPROVED`);
      if (!version.anchorOnly) {
        await tx.chainWrite.create({
          data: { reportVersionId: version.id, kind: 'ANCHOR_COPY', mode: write.mode, chainId: write.chainId, registry: write.registry, issuer: write.issuer },
        });
      }
    } else if (effect?.kind === 'COMPLETE') {
      const completed = await tx.reportVersion.updateMany({
        where: { id: version.id, status: 'ANCHORED', copyDocHash: { not: null } },
        data: { status: 'COMPLETE', copyRecordId: effect.recordId, copyTxHash: effect.txHash, copyBlock: effect.blockNumber, completedAt: ctx.now() },
      });
      if (completed.count !== 1) throw new ChainError('VERSION_NOT_ANCHORED', `version ${version.id} is not ANCHORED with a copy`);
    } else if (effect?.kind === 'REVERT_REVOCATION') {
      await tx.revocation.updateMany({ where: { reportVersionId: version.id, status: 'APPROVED' }, data: { status: 'REQUESTED', approvedById: null, approvedAt: null } });
    } else if (effect?.kind === 'REVOKED') {
      const revokedAt = ctx.now();
      const revoked = await tx.reportVersion.updateMany({ where: { id: version.id, status: { in: ['ANCHORED', 'COMPLETE'] } }, data: { status: 'REVOKED', revokedAt } });
      if (revoked.count !== 1) throw new ChainError('VERSION_NOT_ANCHORED', `version ${version.id} is not ANCHORED or COMPLETE`);
      const closed = await tx.revocation.updateMany({ where: { reportVersionId: version.id, status: 'APPROVED' }, data: { status: 'REVOKED', revokedAt } });
      if (closed.count !== 1) throw new ChainError('REVOCATION_NOT_APPROVED', `version ${version.id} has no approved revocation`);
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

/** What a write that will not happen undoes: the approval it was made under. A copy needs none, so it waits to be queued again. */
function revertApproval(write: Write): VersionEffect | undefined {
  if (write.kind === 'ANCHOR') return { kind: 'REVERT_TO_CONFIRMED' };
  if (write.kind === 'REVOKE') return { kind: 'REVERT_REVOCATION' };
  return undefined;
}

/** A failed ANCHOR or REVOKE returns its approval; a failed ANCHOR_COPY leaves the version ANCHORED, to retry. */
function fail(ctx: Context, write: Write, reason: string, data: Prisma.ChainWriteUpdateManyMutationInput = {}) {
  return transition(ctx, write, 'FAILED', { ...data, error: reason }, {
    version: revertApproval(write),
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
    version: revertApproval(write),
    audit: { action: 'anchor.simulated', data: { outcome: outcome ?? 'WOULD_SUCCEED' } },
  }, outcome ?? 'would succeed');
}

function finalize(ctx: Context, write: Write, final: { txHash: string | null; blockNumber: bigint; recordId: string; linked: boolean; data?: Prisma.ChainWriteUpdateManyMutationInput }) {
  return transition(ctx, write, 'FINAL', { ...final.data, txHash: final.txHash, blockNumber: final.blockNumber, recordId: final.recordId, error: null }, {
    version:
      write.kind === 'REVOKE'
        ? { kind: 'REVOKED' }
        : { kind: write.kind === 'ANCHOR' ? 'ANCHORED' : 'COMPLETE', recordId: final.recordId, txHash: final.txHash, blockNumber: final.blockNumber },
    audit: { action: final.linked ? 'anchor.linked' : 'anchor.final', data: { recordId: final.recordId, txHash: final.txHash, blockNumber: Number(final.blockNumber) } },
  });
}

// ── INTENT: build, check, simulate, then sign and send ──

/** The document a write anchors: the original, or its stamped copy. */
const docOf = (write: Write) => (write.kind === 'ANCHOR' ? write.reportVersion.docHash : write.reportVersion.copyDocHash) as Hex | null;

/** The reason code a REVOKE write sends: its approved revocation's. */
function revocationCodeOf(write: Write): number | null {
  const revocation = write.reportVersion.revocations[0];
  return revocation ? REVOCATION_CODES[revocation.reason] : null;
}

/** The registry call a built write makes. Needs `parentId` (ANCHOR), the copy's hash (ANCHOR_COPY) or an approved revocation (REVOKE). */
function callOf(write: Write) {
  const version = write.reportVersion;
  if (write.kind === 'ANCHOR') {
    return {
      functionName: 'anchor',
      args: [
        version.engagement.familyId as Hex,
        version.version,
        write.parentId as Hex,
        version.docHash as Hex,
        version.manifestHash as Hex,
        version.opinionCommitment as Hex,
      ],
    } as const;
  }
  if (write.kind === 'ANCHOR_COPY') return { functionName: 'anchorDistributionCopy', args: [version.recordId as Hex, version.copyDocHash as Hex] } as const;
  if (write.kind === 'REVOKE') {
    const code = revocationCodeOf(write);
    if (code === null) throw new ChainError('REVOCATION_NOT_APPROVED', `write ${write.id} has no approved revocation`);
    return { functionName: 'revoke', args: [write.recordId as Hex, code] } as const;
  }
  throw new ChainError('KIND_UNSUPPORTED', `the worker does not send ${write.kind} writes`);
}

type Call = ReturnType<typeof callOf>;

/** viem's per-function typing does not follow a union of calls; the ABI still checks names and arity at run time. */
const contractCall = (ctx: Context, call: Call) =>
  ({ address: ctx.registry, abi: registryAbi, functionName: call.functionName, args: call.args, account: ctx.issuer }) as unknown as Parameters<
    PublicClient['simulateContract']
  >[0];

async function issuerBlocked(ctx: Context): Promise<boolean> {
  const count = await ctx.prisma.chainWrite.count({ where: { chainId: ctx.chainId, issuer: ctx.issuer, status: 'INDETERMINATE' } });
  return count > 0;
}

async function startWrite(ctx: Context, write: Write): Promise<StepReport> {
  const orgMode = write.reportVersion.engagement.client.org.chainWriteMode;
  // The brake: a write approved under a wider mode does not start once narrowed.
  if (orgMode === 'DISABLED' || rungOf(orgMode) < rungOf(write.mode)) return fail(ctx, write, 'MODE_NARROWED');
  if (write.kind === 'ANCHOR') return startAnchor(ctx, write);
  if (write.kind === 'ANCHOR_COPY') return startCopy(ctx, write);
  if (write.kind === 'REVOKE') return startRevoke(ctx, write);
  return fail(ctx, write, 'KIND_UNSUPPORTED');
}

async function startAnchor(ctx: Context, write: Write): Promise<StepReport> {
  const version = write.reportVersion;
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

  try {
    await ctx.publicClient.simulateContract(contractCall(ctx, callOf(current)));
  } catch (error) {
    const named = toRegistryError(error);
    if (named instanceof RegistryRevertError) return live ? fail(ctx, current, named.errorName) : simulated(ctx, current, named.errorName);
    throw named;
  }
  if (!live) return simulated(ctx, current, null);
  return signAndSend(ctx, current);
}

/**
 * ANCHOR_COPY: stamp the original (once; a retry reuses the stored copy),
 * then anchor the copy as the original's DISTRIBUTION_COPY. Only ever LIVE: it
 * is queued when a LIVE anchor of the original is final.
 */
async function startCopy(ctx: Context, write: Write): Promise<StepReport> {
  const version = write.reportVersion;
  if (version.anchorOnly) return fail(ctx, write, 'ANCHOR_ONLY');
  if (version.status !== 'ANCHORED' || !version.recordId || version.anchorBlock === null) return fail(ctx, write, 'VERSION_NOT_ANCHORED');
  if (write.mode !== 'LIVE') return fail(ctx, write, 'COPY_NEEDS_LIVE');
  if (await issuerBlocked(ctx)) return release(ctx, write, { error: 'ISSUER_BLOCKED' }, 'waiting: an INDETERMINATE write must be settled first');

  let copyDocHash = version.copyDocHash;
  if (!copyDocHash) {
    const stamped = await stampCopy(ctx, write);
    if (!stamped.ok) return fail(ctx, write, `STAMP_${stamped.reason}`);
    copyDocHash = stamped.docHash;
  }
  const withCopy: Write = { ...write, reportVersion: { ...version, copyDocHash } };

  const existing = await ctx.reader.findByDocHash(copyDocHash as Hex);
  if (existing) return linkExisting(ctx, withCopy, existing);

  const parentId = version.recordId;
  const recordId = recordIdFor(ctx.chainId, ctx.registry, version.engagement.familyId as Hex, version.version, 'DISTRIBUTION_COPY');
  const built = await ctx.prisma.chainWrite.updateMany({ where: { id: write.id, status: 'INTENT', txHash: null }, data: { parentId, recordId, error: null } });
  if (built.count !== 1) return { writeId: write.id, from: 'INTENT', to: 'INTENT', note: 'changed by another writer; left alone' };
  const current: Write = { ...withCopy, parentId, recordId, error: null };
  await ctx.faults.afterBuild?.(write.id);

  try {
    await ctx.publicClient.simulateContract(contractCall(ctx, callOf(current)));
  } catch (error) {
    const named = toRegistryError(error);
    if (named instanceof RegistryRevertError) return fail(ctx, current, named.errorName);
    throw named;
  }
  return signAndSend(ctx, current);
}

/**
 * REVOKE: withdraw the version's original record with the approved reason.
 * The record must be this version's original and final. One already revoked
 * with the same reason is linked, never revoked again; one revoked with
 * another reason is a refusal for a person.
 */
async function startRevoke(ctx: Context, write: Write): Promise<StepReport> {
  const version = write.reportVersion;
  const live = write.mode === 'LIVE';
  if (revocationCodeOf(write) === null) return fail(ctx, write, 'REVOCATION_NOT_APPROVED');
  if ((version.status !== 'ANCHORED' && version.status !== 'COMPLETE') || !version.recordId || version.anchorBlock === null) return fail(ctx, write, 'VERSION_NOT_ANCHORED');
  if (live && (await issuerBlocked(ctx))) return release(ctx, write, { error: 'ISSUER_BLOCKED' }, 'waiting: an INDETERMINATE write must be settled first');

  const [record, finalized] = await Promise.all([ctx.reader.getRecord(version.recordId as Hex), ctx.publicClient.getBlock({ blockTag: 'finalized' })]);
  const isOriginal =
    record !== null && record.kind === 'ORIGINAL' && record.docHash === version.docHash && BigInt(record.blockNumber) === version.anchorBlock && finalized.number >= version.anchorBlock;
  if (!isOriginal) return live ? fail(ctx, write, 'ORIGINAL_RECORD_MISMATCH') : simulated(ctx, write, 'ORIGINAL_RECORD_MISMATCH');
  if (record.revoked) return live ? linkRevocation(ctx, write, record) : simulated(ctx, write, 'AlreadyRevoked');

  const built = await ctx.prisma.chainWrite.updateMany({ where: { id: write.id, status: 'INTENT', txHash: null }, data: { recordId: version.recordId, parentId: null, error: null } });
  if (built.count !== 1) return { writeId: write.id, from: 'INTENT', to: 'INTENT', note: 'changed by another writer; left alone' };
  const current: Write = { ...write, recordId: version.recordId, parentId: null, error: null };
  await ctx.faults.afterBuild?.(write.id);

  try {
    await ctx.publicClient.simulateContract(contractCall(ctx, callOf(current)));
  } catch (error) {
    const named = toRegistryError(error);
    if (named instanceof RegistryRevertError) return live ? fail(ctx, current, named.errorName) : simulated(ctx, current, named.errorName);
    throw named;
  }
  if (!live) return simulated(ctx, current, null);
  return signAndSend(ctx, current);
}

/** Whether a record reads as this REVOKE made it: the version's original, revoked with the approved reason. */
function revocationLanded(record: RegistryRecord | null, write: Write): boolean {
  const version = write.reportVersion;
  return (
    record !== null &&
    record.recordId === write.recordId &&
    record.kind === 'ORIGINAL' &&
    record.docHash === version.docHash &&
    record.familyId === version.engagement.familyId &&
    record.revoked &&
    record.revokeReason === revocationCodeOf(write)
  );
}

/** The final transaction that revoked a record, found by its Revoked event; null until one is final. */
async function revokingTxOf(ctx: Context, record: RegistryRecord): Promise<{ txHash: Hash; blockNumber: bigint } | null> {
  const events = await ctx.publicClient.getContractEvents({
    address: ctx.registry,
    abi: registryAbi,
    eventName: 'Revoked',
    args: { recordId: record.recordId },
    fromBlock: BigInt(record.blockNumber),
    toBlock: 'finalized',
  });
  const event = events.at(-1);
  return event?.transactionHash && event.blockNumber !== null ? { txHash: event.transactionHash, blockNumber: event.blockNumber } : null;
}

/** The record is already revoked: settle on that, sending nothing, once its revocation is final. */
async function linkRevocation(ctx: Context, write: Write, record: RegistryRecord): Promise<StepReport> {
  if (!revocationLanded(record, write)) return fail(ctx, write, 'REVOKED_WITH_OTHER_REASON');
  const revoking = await revokingTxOf(ctx, record);
  if (!revoking) return release(ctx, write, { recordId: record.recordId }, 'already revoked on chain; waiting for finality');
  return finalize(ctx, write, { txHash: revoking.txHash, blockNumber: revoking.blockNumber, recordId: record.recordId, linked: true, data: { nonce: null } });
}

const hexOf = (bytes: Uint8Array) => `0x${Buffer.from(bytes).toString('hex')}` as Hex;

/** The original's record on chain must be this version's, final and not revoked, before anything is written about it. */
async function originalRecordOk(ctx: Context, version: { recordId: string | null; anchorBlock: bigint | null; docHash: string }): Promise<boolean> {
  if (!version.recordId || version.anchorBlock === null) return false;
  const [record, finalized] = await Promise.all([ctx.reader.getRecord(version.recordId as Hex), ctx.publicClient.getBlock({ blockTag: 'finalized' })]);
  return (
    record !== null &&
    record.kind === 'ORIGINAL' &&
    record.docHash === version.docHash &&
    !record.revoked &&
    BigInt(record.blockNumber) === version.anchorBlock &&
    finalized.number >= version.anchorBlock
  );
}

/**
 * Stamps the original with its final anchor, re-reads the copy through the
 * isolated parser, and stores it encrypted (Phase 3 hardening: the stamped PDF
 * is re-parsed and re-hashed before its anchor, and its stamp must equal the
 * final record). Nothing is stored unless every check passes.
 */
async function stampCopy(ctx: Context, write: Write): Promise<{ ok: true; docHash: string } | { ok: false; reason: string }> {
  const version = write.reportVersion;
  if (!(await originalRecordOk(ctx, version))) return { ok: false, reason: 'ORIGINAL_RECORD_MISMATCH' };
  if (!version.anchorTxHash) return { ok: false, reason: 'ORIGINAL_TX_UNKNOWN' };
  if (!version.opinionType || !version.opinionSalt) return { ok: false, reason: 'VERSION_INCOMPLETE' };
  const fields: StampFields = {
    stamp: STAMP_VERSION,
    chainId: ctx.chainId,
    contract: ctx.registry,
    recordId: version.recordId as Hex,
    txHash: version.anchorTxHash as Hex,
    blockNumber: Number(version.anchorBlock),
    familyId: version.engagement.familyId as Hex,
    version: version.version,
    verifyUrl: ctx.verifyUrl,
    opinionType: version.opinionType,
    opinionSalt: hexOf(version.opinionSalt),
    norm: NORMALISER_VERSION,
  };
  const original = await ctx.files.read(version.storedFile);
  // The copy must be of exactly the file that was anchored.
  if (docHashOf(original) !== version.docHash) return { ok: false, reason: 'ORIGINAL_HASH_MISMATCH' };
  let stamped: Uint8Array;
  try {
    stamped = await stampPdf(original, fields);
  } catch (error) {
    if (error instanceof StampError) return { ok: false, reason: error.code };
    throw error;
  }
  const check = await checkStampedCopy(original, stamped, fields);
  if (!check.ok) return { ok: false, reason: check.reason };

  const stored = await ctx.files.store(stamped);
  try {
    await ctx.prisma.$transaction(async (tx) => {
      const file = await tx.storedFile.create({ data: stored, select: { id: true } });
      const { count } = await tx.reportVersion.updateMany({
        where: { id: version.id, status: 'ANCHORED', copyDocHash: null },
        data: { copyDocHash: check.docHash, copyStoredFileId: file.id },
      });
      if (count !== 1) throw new ChainError('VERSION_NOT_ANCHORED', `version ${version.id} already has a copy or is not ANCHORED`);
      await appendAuditEvent(
        tx,
        {
          orgId: version.engagement.client.orgId,
          actorId: null,
          action: 'version.stamped',
          subjectType: 'ReportVersion',
          subjectId: version.id,
          data: { chainWriteId: write.id, recordId: fields.recordId, copyDocHash: check.docHash },
        },
        ctx.now(),
      );
    });
  } catch (error) {
    await ctx.files.discard(stored.path);
    throw error;
  }
  return { ok: true, docHash: check.docHash };
}

/**
 * Anchor-only versions (signed or edit-protected) are never rewritten: once
 * their ANCHOR is final they get a verification certificate and are COMPLETE.
 */
async function certifyAnchorOnly(ctx: Context, report: PassReport) {
  const versions = await ctx.prisma.reportVersion.findMany({
    where: {
      status: 'ANCHORED',
      anchorOnly: true,
      certificateStoredFileId: null,
      chainWrites: { some: { kind: 'ANCHOR', status: 'FINAL', chainId: ctx.chainId, registry: ctx.registry, issuer: ctx.issuer } },
    },
    include: { engagement: { include: { client: { select: { orgId: true } } } } },
    orderBy: { createdAt: 'asc' },
    take: 20,
  });
  for (const version of versions) {
    let storedPath: string | null = null;
    try {
      if (!(await originalRecordOk(ctx, version))) {
        ctx.log('error', 'not certifying: the record on chain does not match the version', { versionId: version.id });
        continue;
      }
      const certificate = await certificatePdf({
        version: version.version,
        docHash: version.docHash,
        recordId: version.recordId!,
        familyId: version.engagement.familyId,
        chainId: ctx.chainId,
        networkName: networkNameOf(ctx.chainId),
        contract: ctx.registry,
        txHash: version.anchorTxHash,
        blockNumber: Number(version.anchorBlock),
        verifyUrl: ctx.verifyUrl,
        explorerTxUrl: version.anchorTxHash ? explorerTxUrl(ctx.chainId, version.anchorTxHash) : null,
      });
      const stored = await ctx.files.store(certificate);
      storedPath = stored.path;
      await ctx.prisma.$transaction(async (tx) => {
        const file = await tx.storedFile.create({ data: stored, select: { id: true } });
        const { count } = await tx.reportVersion.updateMany({
          where: { id: version.id, status: 'ANCHORED', certificateStoredFileId: null },
          data: { status: 'COMPLETE', certificateStoredFileId: file.id, completedAt: ctx.now() },
        });
        if (count !== 1) throw new ChainError('VERSION_NOT_ANCHORED', `version ${version.id} is no longer waiting for a certificate`);
        await appendAuditEvent(
          tx,
          {
            orgId: version.engagement.client.orgId,
            actorId: null,
            action: 'version.certified',
            subjectType: 'ReportVersion',
            subjectId: version.id,
            data: { recordId: version.recordId, certificateSha256: stored.sha256 },
          },
          ctx.now(),
        );
      });
      storedPath = null;
      report.certified.push(version.id);
    } catch (error) {
      if (storedPath) await ctx.files.discard(storedPath);
      report.errors.push({ writeId: version.id, error: errorName(error) });
      ctx.log('error', 'certificate failed; retried next pass', { versionId: version.id, error: errorName(error) });
    }
  }
}

/** Whether a record is the one this write makes: same kind, document, family, version and commitments. */
function recordIsThisVersion(record: RegistryRecord, write: Write): boolean {
  const version = write.reportVersion;
  const copy = write.kind === 'ANCHOR_COPY';
  return (
    record.kind === (copy ? 'DISTRIBUTION_COPY' : 'ORIGINAL') &&
    (!copy || record.parentId === version.recordId) &&
    record.familyId === version.engagement.familyId &&
    record.version === version.version &&
    record.docHash === docOf(write) &&
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

async function signAndSend(ctx: Context, write: Write): Promise<StepReport> {
  const call = callOf(write);
  const [nonce, gasEstimate, fees] = await Promise.all([
    nextNonce(ctx),
    ctx.publicClient.estimateContractGas(contractCall(ctx, call) as Parameters<PublicClient['estimateContractGas']>[0]),
    ctx.publicClient.estimateFeesPerGas(),
  ]);
  const gas = (gasEstimate * BigInt(100 + ctx.options.gasHeadroomPercent)) / 100n;
  const serialized = await ctx.account.signTransaction({
    chainId: ctx.chainId,
    type: 'eip1559',
    to: ctx.registry,
    data: encodeFunctionData({ abi: registryAbi, functionName: call.functionName, args: call.args } as Parameters<typeof encodeFunctionData>[0]),
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

const hashesOf = (write: Write) => hashesOfWrite(write);

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
  const receipt = await firstReceipt(ctx.publicClient, hashes);
  if (!receipt) {
    if (!(await anyKnown(ctx.publicClient, hashes))) return indeterminate(ctx, write, 'TX_NOT_FOUND');
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
  const again = await receiptOf(ctx.publicClient, landed);
  if (!again || again.blockHash !== receipt.blockHash) return release(ctx, write, {}, 'block changed; checking again next pass');

  const record = write.recordId ? await ctx.reader.getRecord(write.recordId as Hex) : null;
  const landedAsSent = write.kind === 'REVOKE' ? revocationLanded(record, write) : recordMatches(record, write, ctx.issuer, receipt.blockNumber);
  if (!landedAsSent) return indeterminate(ctx, write, 'RECORD_MISMATCH', settled);
  return finalize(ctx, write, { txHash: landed, blockNumber: receipt.blockNumber, recordId: write.recordId!, linked: false, data: { replacedTxHashes: settled.replacedTxHashes } });
}

/** The same call at the same nonce with both fee caps raised: only one of the two can ever be mined. */
async function replace(ctx: Context, write: Write): Promise<StepReport> {
  const built = write.kind === 'REVOKE' ? write.recordId !== null : write.parentId !== null;
  if (write.nonce === null || !write.txHash || !built || !write.gasLimit || !write.maxFeePerGas || !write.maxPriorityFeePerGas) {
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
    data: encodeFunctionData({ abi: registryAbi, ...callOf(write) } as Parameters<typeof encodeFunctionData>[0]),
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
  if ((await firstReceipt(ctx.publicClient, hashes)) || (await anyKnown(ctx.publicClient, hashes))) {
    // It was sent: track it like any broadcast.
    return transition(ctx, write, 'BROADCAST', { broadcastAt: write.broadcastAt ?? ctx.now(), error: null }, {
      audit: { action: 'anchor.broadcast', data: { txHash: write.txHash, nonce: write.nonce, reconciled: true } },
    }, 'found on chain');
  }
  if (finalizedNonce > write.nonce) {
    // Another transaction used this nonce, so ours can never be mined.
    if (write.kind === 'REVOKE') {
      const record = write.recordId ? await ctx.reader.getRecord(write.recordId as Hex) : null;
      if (record && revocationLanded(record, write)) {
        const revoking = await revokingTxOf(ctx, record);
        if (!revoking) return release(ctx, write, {}, 'revoked on chain; waiting for finality');
        return finalize(ctx, write, { txHash: revoking.txHash, blockNumber: revoking.blockNumber, recordId: record.recordId, linked: true, data: { nonce: null } });
      }
      return fail(ctx, write, 'NONCE_CONSUMED', { nonce: null });
    }
    const doc = docOf(write);
    const record = doc ? await ctx.reader.findByDocHash(doc) : null;
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
