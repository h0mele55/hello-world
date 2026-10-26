import { getAddress, keccak256, type Address, type Hash, type Hex, type PublicClient } from 'viem';
import { archiveOf, checkpointOf, checkReanchorSet, proofsOf, type ArchivedRecord, type Checkpoint, type CheckpointProof, type ReanchorArchive, type ReanchorProof } from '../verify-core/reanchor';
import { agreedFinalizedBlock, readOnBoth } from './agree';
import { orgIdFor } from './deploy';
import { BytecodeMismatchError, ChainError, ChainMismatchError } from './errors';
import { decodeRecord, ZERO_HASH } from './records';
import { registryAbi } from './registry-artifact';

/**
 * Reads every record a registry holds, for its re-anchoring (#65,
 * docs/runbooks/sepolia-sunset.md) or its monthly checkpoint (#122,
 * docs/runbooks/checkpoints.md): each record named by an Anchored event,
 * read with getRecord at one finalized block two endpoints agree on, with its
 * block's time, its transaction, its issuer's org and its family's latest, all
 * read on both. It only reads.
 *
 * The source may be an older build of the registry than this code: it is held
 * to the bytecode its own deployment record names, and read only through what
 * every build has had (Anchored, getRecord, latestOf, issuers).
 *
 * Refused, with a named code: a registry with no records
 * (NOTHING_TO_REANCHOR); and, for a re-anchoring only, a revocation still
 * waiting out the registry's delay at the snapshot (REVOCATION_PENDING),
 * since the archive would hold it pending for ever. A checkpoint of a live
 * registry holds a pending revocation as pending: that is what it was then.
 */

export interface ReanchorSource {
  chainId: number;
  address: Address;
  runtimeBytecodeHash: Hex;
  /** Where the event scan starts. */
  deployBlock: number;
}

export interface ReadDeps {
  /** Two endpoints from different providers; one client twice on a local chain. */
  clients: readonly [PublicClient, PublicClient];
  source: ReanchorSource;
  /** Names of the source's issuer firms, each the one its org id is the hash of. */
  issuerNames?: readonly string[];
  rangeBlocks?: number;
}

export interface BuildDeps extends ReadDeps {
  target: { chainId: number; registry: Address };
}

const RANGE_BLOCKS = 2_000;

export async function buildReanchorArchive(deps: BuildDeps): Promise<{ archive: ReanchorArchive; proofs: ReanchorProof[] }> {
  const read = await readRegistryRecords(deps, { refusePending: true });
  const archive = archiveOf({ source: read.source, target: deps.target }, read.records, read.issuers);
  // Held to its own checks before anyone records its root.
  checkReanchorSet(archive);
  return { archive, proofs: proofsOf(archive) };
}

/** A month's checkpoint of a live registry, its timestamp still to come. */
export async function buildCheckpoint(deps: ReadDeps & { period: string }): Promise<{ checkpoint: Checkpoint; proofs: CheckpointProof[] }> {
  const read = await readRegistryRecords(deps, { refusePending: false });
  const checkpoint = checkpointOf(read.source, deps.period, read.records, read.issuers);
  checkReanchorSet(checkpoint);
  return { checkpoint, proofs: proofsOf(checkpoint) };
}

/** Every record, at one finalized block both endpoints agree on. */
export async function readRegistryRecords(
  deps: ReadDeps,
  options: { refusePending: boolean },
): Promise<{ source: { chainId: number; registry: Address; block: number }; records: ArchivedRecord[]; issuers: Record<string, string> }> {
  const { clients, source } = deps;
  const address = source.address;
  // Each endpoint on its own: the wrong chain or code is a refusal (rule 7).
  for (const client of new Set(clients)) {
    const chainId = await client.getChainId();
    if (chainId !== source.chainId) throw new ChainMismatchError(source.chainId, chainId);
    const code = await client.getCode({ address });
    if (!code || keccak256(code) !== source.runtimeBytecodeHash) throw new BytecodeMismatchError(address);
  }
  const block = await agreedFinalizedBlock(clients);
  const read = <T>(what: string, run: (client: PublicClient) => Promise<T>) => readOnBoth(clients, what, run);

  const anchored: { recordId: Hex; txHash: Hash; blockNumber: number }[] = [];
  const range = BigInt(deps.rangeBlocks ?? RANGE_BLOCKS);
  for (let from = BigInt(source.deployBlock); from <= block; from += range) {
    const to = from + range - 1n < block ? from + range - 1n : block;
    const events = await read(`the registry's anchors in blocks ${from} to ${to}`, async (c) =>
      (await c.getContractEvents({ address, abi: registryAbi, eventName: 'Anchored', fromBlock: from, toBlock: to })).map((e) => ({
        recordId: e.args.recordId!.toLowerCase() as Hex,
        txHash: e.transactionHash.toLowerCase() as Hash,
        blockNumber: Number(e.blockNumber),
      })),
    );
    anchored.push(...events);
  }
  if (anchored.length === 0) throw new ChainError('NOTHING_TO_REANCHOR', `the registry at ${address} holds no records at block ${block}`);

  const at = { address, abi: registryAbi, blockNumber: block } as const;
  const blockTimes = new Map<number, Promise<number>>();
  const orgs = new Map<Address, Promise<Hex | null>>();
  const latest = new Map<Hex, Promise<Hex>>();
  const once = <K, V>(cache: Map<K, Promise<V>>, key: K, load: () => Promise<V>) => {
    if (!cache.has(key)) cache.set(key, load());
    return cache.get(key)!;
  };

  const records: ArchivedRecord[] = [];
  for (const event of anchored) {
    const raw = await read(`record ${event.recordId}`, (c) => c.readContract({ ...at, functionName: 'getRecord', args: [event.recordId] }));
    const record = decodeRecord(event.recordId, raw);
    if (!record || record.blockNumber !== event.blockNumber) throw new ChainError('CHAIN_INCONSISTENT', `record ${event.recordId} is not what its Anchored event says`);
    if (options.refusePending && record.revokeReason !== 0 && !record.revoked) {
      const when = new Date(record.revokeEffectiveAt * 1000).toISOString();
      throw new ChainError('REVOCATION_PENDING', `the revocation of record ${event.recordId} takes effect at ${when}: re-anchor after it, or once the owner has cancelled it`);
    }
    const issuer = getAddress(record.issuer);
    const [blockTime, orgId, familyLatest] = await Promise.all([
      once(blockTimes, record.blockNumber, async () => Number(await read(`block ${record.blockNumber}'s time`, async (c) => (await c.getBlock({ blockNumber: BigInt(record.blockNumber) })).timestamp))),
      once(orgs, issuer, async () => {
        const [org] = await read(`the firm of key ${issuer}`, (c) => c.readContract({ ...at, functionName: 'issuers', args: [issuer] }));
        return org === ZERO_HASH ? null : (org.toLowerCase() as Hex);
      }),
      once(latest, record.familyId.toLowerCase() as Hex, async () => (await read(`the latest of family ${record.familyId}`, (c) => c.readContract({ ...at, functionName: 'latestOf', args: [record.familyId] }))).toLowerCase() as Hex),
    ]);
    records.push({
      ...record,
      recordId: event.recordId,
      familyId: record.familyId.toLowerCase() as Hex,
      docHash: record.docHash.toLowerCase() as Hex,
      manifestHash: record.manifestHash.toLowerCase() as Hex,
      opinionCommitment: record.opinionCommitment.toLowerCase() as Hex,
      parentId: record.parentId.toLowerCase() as Hex,
      issuer,
      blockTime,
      txHash: event.txHash,
      orgId,
      familyLatest,
    });
  }

  const held = new Set(records.map((r) => r.orgId).filter((o): o is Hex => o !== null));
  const issuers: Record<string, string> = {};
  for (const name of deps.issuerNames ?? []) {
    const orgId = orgIdFor(name).toLowerCase();
    if (held.has(orgId as Hex)) issuers[orgId] = name;
  }

  return { source: { chainId: source.chainId, registry: getAddress(address), block: Number(block) }, records, issuers };
}
