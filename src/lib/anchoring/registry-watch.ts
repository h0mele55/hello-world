import { getAddress, type Address, type Hash, type Hex, type PublicClient } from 'viem';
import { Prisma, type PrismaClient } from '@/generated/prisma/client';
import type { UnjournaledKind } from '@/generated/prisma/enums';
import { appendAuditEvent } from '@/lib/audit';
import type { Deployment } from '@/lib/chain/deployment';
import { createRegistryReader } from '@/lib/chain/reader';
import { registryAbi } from '@/lib/chain/registry-artifact';

/**
 * The registry watch (#93): the detection half of a stolen issuer key. Every
 * chain write the app makes is journalled, with its transaction hash, before
 * the bytes leave (rule 3). So a write on chain by one of the firm's issuer
 * keys whose hash no journal row holds was made by someone else: a stolen key,
 * or a row lost in a restore. The watch reads every `Anchored`,
 * `RevocationRequested` and `AuditHeadRecorded` (#94) event up to the
 * finalized block (rule 2), keeps the firm's, matches each to the journal by
 * hash, and reports the rest.
 *
 * A forged version 1 under the firm's name, a forged reissue, a copy, and above
 * all a revocation: each is reported. A revocation is reported with the time it
 * takes effect, which is the owner's deadline to cancel it (#95,
 * docs/runbooks/stolen-issuer-key.md).
 *
 * The checkpoint (the last block read) and the findings are written in one
 * transaction per range, so a run that stops halfway resumes where it stopped,
 * and a finding is never reported twice. A finding stays open until an admin
 * has reviewed it. Runs outside the app (scripts/watch-registry.ts).
 */

/** Blocks read per request; public endpoints cap a log query's range. */
export const WATCH_RANGE_BLOCKS = 2_000;

export interface WatchFirm {
  /** The firm in the database. */
  orgId: string;
  /** The firm on chain: the org id its issuer keys are registered under. */
  onChainOrgId: Hex;
}

export interface WatchDeps {
  prisma: PrismaClient;
  publicClient: PublicClient;
  deployment: Deployment;
  firm: WatchFirm;
  /** Where a first run starts: the registry's deploy block. */
  fromBlock?: bigint;
  now?: () => Date;
  rangeBlocks?: number;
}

export interface UnjournaledFinding {
  kind: UnjournaledKind;
  /** The record written, or for an audit-log head the head itself. */
  recordId: Hex;
  txHash: Hash;
  blockNumber: bigint;
  issuer: Address;
  /** A revocation: when it takes effect (Unix seconds). */
  effectiveAt: number | null;
}

export interface WatchReport {
  /** The blocks read in this run, inclusive; `from > to` when there was nothing new. */
  from: bigint;
  to: bigint;
  /** Writes by the firm's keys read in this run, journalled or not. */
  seen: number;
  /** Found in this run. */
  found: UnjournaledFinding[];
  /** Found in any run and not yet reviewed. */
  open: number;
}

const isUniqueViolation = (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

export async function watchRegistry(deps: WatchDeps): Promise<WatchReport> {
  const { prisma, publicClient, deployment, firm } = deps;
  const now = deps.now ?? (() => new Date());
  const range = BigInt(deps.rangeBlocks ?? WATCH_RANGE_BLOCKS);
  const registry = getAddress(deployment.address);
  const chainId = deployment.chainId;
  const key = { orgId: firm.orgId, chainId, registry };

  // The wrong chain or contract is a refusal, never a quiet "nothing found" (rule 7).
  await createRegistryReader(publicClient, deployment).assertDeployment();
  const finalized = (await publicClient.getBlock({ blockTag: 'finalized' })).number;
  const checkpoint = await prisma.registryWatch.findUnique({ where: { orgId_chainId_registry: key } });
  const start = checkpoint ? checkpoint.lastBlock + 1n : (deps.fromBlock ?? 0n);

  // A key's firm never changes (setIssuer refuses it), so one read per key is enough.
  const firmOf = new Map<Address, boolean>();
  async function isFirms(issuer: Address) {
    const known = firmOf.get(issuer);
    if (known !== undefined) return known;
    const [orgId] = await publicClient.readContract({ address: registry, abi: registryAbi, functionName: 'issuers', args: [issuer] });
    const firms = orgId.toLowerCase() === firm.onChainOrgId.toLowerCase();
    firmOf.set(issuer, firms);
    return firms;
  }

  const found: UnjournaledFinding[] = [];
  let seen = 0;
  for (let from = start; from <= finalized; from += range) {
    const to = from + range - 1n < finalized ? from + range - 1n : finalized;
    const [anchored, requested, heads] = await Promise.all([
      publicClient.getContractEvents({ address: registry, abi: registryAbi, eventName: 'Anchored', fromBlock: from, toBlock: to }),
      publicClient.getContractEvents({ address: registry, abi: registryAbi, eventName: 'RevocationRequested', fromBlock: from, toBlock: to }),
      // A head is filed under its key's firm, so the firm's are asked for by name (#94).
      publicClient.getContractEvents({ address: registry, abi: registryAbi, eventName: 'AuditHeadRecorded', args: { orgId: firm.onChainOrgId }, fromBlock: from, toBlock: to }),
    ]);
    const writes: UnjournaledFinding[] = [];
    for (const event of anchored) {
      const { recordId, kind, issuer } = event.args;
      if (!recordId || kind === undefined || !issuer || !(await isFirms(getAddress(issuer)))) continue;
      writes.push({ kind: kind === 0 ? 'ANCHOR' : 'ANCHOR_COPY', recordId, txHash: event.transactionHash, blockNumber: event.blockNumber, issuer: getAddress(issuer), effectiveAt: null });
    }
    for (const event of requested) {
      const { recordId, effectiveAt, issuer } = event.args;
      if (!recordId || effectiveAt === undefined || !issuer || !(await isFirms(getAddress(issuer)))) continue;
      writes.push({ kind: 'REVOCATION', recordId, txHash: event.transactionHash, blockNumber: event.blockNumber, issuer: getAddress(issuer), effectiveAt: Number(effectiveAt) });
    }
    for (const event of heads) {
      const { head, issuer } = event.args;
      if (!head || !issuer) continue;
      writes.push({ kind: 'AUDIT_HEAD', recordId: head, txHash: event.transactionHash, blockNumber: event.blockNumber, issuer: getAddress(issuer), effectiveAt: null });
    }
    seen += writes.length;

    // Every hash the app ever sent is in the journal, a replaced one included.
    const hashes = [...new Set(writes.map((w) => w.txHash.toLowerCase()))];
    const rows = hashes.length
      ? await prisma.chainWrite.findMany({
          where: { chainId, registry, OR: [{ txHash: { in: hashes } }, { replacedTxHashes: { hasSome: hashes } }] },
          select: { txHash: true, replacedTxHashes: true },
        })
      : [];
    const journalled = new Set(rows.flatMap((r) => [r.txHash, ...r.replacedTxHashes]).filter((h): h is string => !!h).map((h) => h.toLowerCase()));
    const unjournaled = writes.filter((w) => !journalled.has(w.txHash.toLowerCase()));

    // Reported only once the range's transaction commits.
    const reported: UnjournaledFinding[] = [];
    await prisma.$transaction(async (tx) => {
      for (const write of unjournaled) {
        let row;
        try {
          row = await tx.unjournaledWrite.create({
            data: {
              orgId: firm.orgId,
              chainId,
              registry,
              kind: write.kind,
              recordId: write.recordId,
              txHash: write.txHash,
              blockNumber: write.blockNumber,
              issuer: write.issuer,
              effectiveAt: write.effectiveAt === null ? null : new Date(write.effectiveAt * 1000),
              foundAt: now(),
            },
            select: { id: true },
          });
        } catch (error) {
          // Another run reported it first.
          if (isUniqueViolation(error)) throw new WatchRaced();
          throw error;
        }
        await appendAuditEvent(
          tx,
          {
            orgId: firm.orgId,
            actorId: null,
            action: 'registry_watch.unjournaled',
            subjectType: 'UnjournaledWrite',
            subjectId: row.id,
            data: {
              kind: write.kind,
              recordId: write.recordId,
              txHash: write.txHash,
              blockNumber: Number(write.blockNumber),
              issuer: write.issuer,
              effectiveAt: write.effectiveAt === null ? null : new Date(write.effectiveAt * 1000).toISOString(),
            },
          },
          now(),
        );
        reported.push(write);
      }
      await advanceCheckpoint(tx, key, to, now());
    }).then(
      () => found.push(...reported),
      (error: unknown) => {
        // Another run reported this range first, and moved the checkpoint past it.
        if (!(error instanceof WatchRaced)) throw error;
      },
    );
  }
  if (start > finalized) await advanceCheckpoint(prisma, key, start - 1n, now());

  const open = await prisma.unjournaledWrite.count({ where: { orgId: firm.orgId, reviewedAt: null } });
  return { from: start, to: finalized, seen, found, open };
}

/** Another watch run got to these blocks first; this one leaves them to it. */
class WatchRaced extends Error {}

/** Moves the checkpoint forward, never back: a slower run at the same time cannot make the watch read a range again. */
async function advanceCheckpoint(
  client: Prisma.TransactionClient | PrismaClient,
  key: { orgId: string; chainId: number; registry: string },
  lastBlock: bigint,
  checkedAt: Date,
) {
  const moved = await client.registryWatch.updateMany({ where: { ...key, lastBlock: { lte: lastBlock } }, data: { lastBlock, checkedAt } });
  if (moved.count === 1) return;
  // None, or one further on (a run that went past this one), which stays.
  const exists = await client.registryWatch.findUnique({ where: { orgId_chainId_registry: key }, select: { lastBlock: true } });
  if (!exists) await client.registryWatch.create({ data: { ...key, lastBlock, checkedAt } });
}
