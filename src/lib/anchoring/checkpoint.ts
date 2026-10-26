import { getAddress, type Address, type Hex, type PublicClient } from 'viem';
import type { PrismaClient } from '@/generated/prisma/client';
import { appendAuditEvent } from '@/lib/audit';
import { ChainError } from '@/lib/chain/errors';
import { buildCheckpoint } from '@/lib/chain/reanchor-build';
import { previousMonth } from '@/lib/console/periods';
import { CHECKPOINT_FORMAT, checkpointDigest, checkpointHead, checkReanchorSet, proofsOf, type Checkpoint, type CheckpointProof } from '@/lib/verify-core/reanchor';

/**
 * The monthly checkpoint of the registry the firm anchors on (#122), run by
 * `npm run checkpoint` (scripts/checkpoint.ts) on the 1st of each month.
 * Every record the registry holds, read at one finalized block both endpoints
 * agree on, goes under one Merkle root; the checkpoint is kept as written
 * (RegistryCheckpoint, append-only), and the OpenTimestamps job timestamps
 * the SHA-256 of its head (registry, block, month, count and root) on Bitcoin. Once that proof is COMPLETE, the checkpoint
 * is exported with it and published, so the records outlive the chain's own
 * infrastructure.
 *
 * It holds no key and writes no chain. A checkpoint holds only what the chain
 * already made public: commitments, pseudonymous ids and the firm's name.
 */

export interface CheckpointDeps {
  prisma: PrismaClient;
  /** Two endpoints from different providers; one client twice on a local chain. */
  clients: readonly [PublicClient, PublicClient];
  deployment: { chainId: number; address: Address; runtimeBytecodeHash: Hex; deployBlock: number };
  /** The firm: its row, and the name its org id on chain is the hash of. */
  firm: { orgId: string; name: string };
  now?: () => Date;
  rangeBlocks?: number;
}

export type CheckpointOutcome =
  | { status: 'CREATED'; checkpointId: string; period: string; root: Hex; count: number; block: number }
  /** The month already has its checkpoint: a second run changes nothing. */
  | { status: 'EXISTS'; checkpointId: string; period: string }
  /** The registry holds no record yet: there is nothing to checkpoint. */
  | { status: 'EMPTY'; period: string };

export async function runCheckpoint(deps: CheckpointDeps): Promise<CheckpointOutcome> {
  const now = deps.now ?? (() => new Date());
  const period = previousMonth(now());
  const registry = deps.deployment.address.toLowerCase();
  const key = { orgId: deps.firm.orgId, chainId: deps.deployment.chainId, registry, period };
  const existing = await deps.prisma.registryCheckpoint.findUnique({ where: { orgId_chainId_registry_period: key }, select: { id: true } });
  if (existing) return { status: 'EXISTS', checkpointId: existing.id, period };

  let checkpoint: Checkpoint;
  try {
    ({ checkpoint } = await buildCheckpoint({
      clients: deps.clients,
      source: { chainId: deps.deployment.chainId, address: deps.deployment.address, runtimeBytecodeHash: deps.deployment.runtimeBytecodeHash, deployBlock: deps.deployment.deployBlock },
      issuerNames: [deps.firm.name],
      period,
      rangeBlocks: deps.rangeBlocks,
    }));
  } catch (error) {
    if (error instanceof ChainError && error.code === 'NOTHING_TO_REANCHOR') return { status: 'EMPTY', period };
    throw error;
  }

  const at = now();
  try {
    const row = await deps.prisma.$transaction(async (tx) => {
      const created = await tx.registryCheckpoint.create({
        data: { ...key, block: checkpoint.source.block, root: checkpoint.root, count: checkpoint.records.length, file: new TextEncoder().encode(JSON.stringify(checkpoint)) },
        select: { id: true },
      });
      await appendAuditEvent(
        tx,
        {
          orgId: deps.firm.orgId,
          actorId: null,
          action: 'checkpoint.created',
          subjectType: 'RegistryCheckpoint',
          subjectId: created.id,
          data: { period, chainId: deps.deployment.chainId, registry, block: checkpoint.source.block, root: checkpoint.root, count: checkpoint.records.length },
        },
        at,
      );
      return created;
    });
    return { status: 'CREATED', checkpointId: row.id, period, root: checkpoint.root, count: checkpoint.records.length, block: checkpoint.source.block };
  } catch (error) {
    // Another run made the month's checkpoint first.
    if ((error as { code?: string }).code !== 'P2002') throw error;
    const other = await deps.prisma.registryCheckpoint.findUniqueOrThrow({ where: { orgId_chainId_registry_period: key }, select: { id: true } });
    return { status: 'EXISTS', checkpointId: other.id, period };
  }
}

export type CheckpointExport =
  | { status: 'READY'; checkpoint: Checkpoint; proofs: CheckpointProof[]; ots: Uint8Array; head: Uint8Array; bitcoinHeight: number }
  /** Its timestamp is not on Bitcoin yet: published only once it is. */
  | { status: 'NOT_YET'; reason: 'NOT_SUBMITTED' | 'PENDING' | 'BROKEN' }
  | { status: 'UNKNOWN' };

/**
 * A month's checkpoint, with its COMPLETE OpenTimestamps proof, ready to
 * publish: the checkpoint file and each record's proof carry the proof, and
 * its head and the .ots file go beside them for the reference client. The stored file is held to its own root again before it leaves.
 */
export async function exportCheckpoint(prisma: PrismaClient, where: { orgId: string; chainId: number; registry: string; period: string }): Promise<CheckpointExport> {
  const row = await prisma.registryCheckpoint.findUnique({
    where: { orgId_chainId_registry_period: { ...where, registry: where.registry.toLowerCase() } },
    select: { chainId: true, registry: true, block: true, period: true, count: true, root: true, file: true, otsProof: { select: { status: true, proof: true, digest: true, bitcoinHeight: true } } },
  });
  if (!row) return { status: 'UNKNOWN' };
  const proof = row.otsProof;
  if (!proof) return { status: 'NOT_YET', reason: 'NOT_SUBMITTED' };
  if (proof.status !== 'COMPLETE') return { status: 'NOT_YET', reason: proof.status === 'BROKEN' ? 'BROKEN' : 'PENDING' };
  const fields = { source: { chainId: row.chainId, registry: row.registry as Hex, block: row.block }, period: row.period, count: row.count, root: row.root as Hex };
  if (proof.digest !== checkpointDigest(fields)) throw new Error(`the checkpoint's proof is of ${proof.digest}, not of its head`);

  const stored = JSON.parse(new TextDecoder().decode(row.file)) as Checkpoint;
  if (stored.format !== CHECKPOINT_FORMAT || stored.root !== row.root) throw new Error('the stored checkpoint is not the one recorded');
  const ots = new Uint8Array(proof.proof);
  const checkpoint: Checkpoint = { ...stored, source: { ...stored.source, registry: getAddress(stored.source.registry) }, ots: Buffer.from(ots).toString('base64') };
  checkReanchorSet(checkpoint);
  return { status: 'READY', checkpoint, proofs: proofsOf(checkpoint), ots, head: checkpointHead(fields), bitcoinHeight: proof.bitcoinHeight! };
}
