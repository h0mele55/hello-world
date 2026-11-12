import { getAddress, keccak256, type Address, type Hash, type Hex, type PublicClient } from 'viem';
import { archiveOf, checkpointOf, checkReanchorSet, leafOf, proofsOf, type ArchivedRecord, type Checkpoint, type CheckpointProof, type CheckedSet, type ReanchorArchive, type ReanchorProof } from '../verify-core/reanchor';
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
  /**
   * The records an earlier read held at its finalized block, a checkpoint of
   * this very registry (#142): their events are not scanned again, only the
   * blocks after it. Every record is still read again at the new block.
   */
  known?: { block: number; records: readonly { recordId: Hex; txHash: Hash; blockNumber: number }[] };
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

/**
 * Holds an archive to the registry it says it came from (#155), before its
 * root is recorded or while it is checked: the source is read again on both
 * endpoints at the archive's own block, the archive rebuilt from what it held
 * then, and anything but the same root is ARCHIVE_DIFFERS, naming the records
 * that differ. An archive is otherwise checked only against itself, which an
 * archive edited after it was built (a record added, a revoked one shown
 * standing, a family's latest changed) and rebuilt passes.
 *
 * A source that cannot be read is SOURCE_UNREADABLE, never a pass; once its
 * chain is gone, only a person can decide to go on without this check.
 */
export async function checkArchiveAgainstSource(deps: ReadDeps, archive: CheckedSet): Promise<{ root: Hex; count: number; block: number }> {
  if (!archive.complete || !archive.target) throw new ChainError('NOT_AN_ARCHIVE', 'only a whole re-anchor archive is compared with its source registry');
  if (archive.source.chainId !== deps.source.chainId || archive.source.registry.toLowerCase() !== deps.source.address.toLowerCase()) {
    throw new ChainError('ARCHIVE_NOT_OF_SOURCE', `the archive is of registry ${archive.source.registry} on chain ${archive.source.chainId}, not ${deps.source.address} on chain ${deps.source.chainId}`);
  }
  let read: Awaited<ReturnType<typeof readRegistryRecords>>;
  try {
    read = await readRegistryRecords({ ...deps, issuerNames: Object.values(archive.issuers) }, { refusePending: true, atBlock: archive.source.block });
  } catch (error) {
    if (error instanceof ChainError) throw error;
    throw new ChainError('SOURCE_UNREADABLE', `the source registry could not be read at block ${archive.source.block}: ${error instanceof Error ? error.name : 'unknown error'}`);
  }
  const rebuilt = archiveOf({ source: read.source, target: archive.target }, read.records, read.issuers);
  if (rebuilt.root !== archive.root || rebuilt.records.length !== archive.count) {
    const leaves = (records: ArchivedRecord[]) => new Map(records.map((r) => [r.recordId.toLowerCase(), leafOf(read.source, r)]));
    const held = leaves(rebuilt.records);
    const claimed = leaves(archive.records);
    const differ = [...new Set([...held.keys(), ...claimed.keys()])].filter((id) => held.get(id) !== claimed.get(id));
    throw new ChainError(
      'ARCHIVE_DIFFERS',
      `the archive is not what the registry held at block ${archive.source.block}: ${differ.length} record(s) differ or are missing (${differ.slice(0, 5).join(', ')}${differ.length > 5 ? ', …' : ''})`,
    );
  }
  return { root: rebuilt.root, count: rebuilt.records.length, block: read.source.block };
}

/**
 * Every record, at one finalized block both endpoints agree on; or, with
 * `atBlock`, at that earlier block, which must be finalized (#155).
 */
export async function readRegistryRecords(
  deps: ReadDeps,
  options: { refusePending: boolean; atBlock?: number },
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
  const finalized = await agreedFinalizedBlock(clients);
  if (options.atBlock !== undefined && BigInt(options.atBlock) > finalized) {
    throw new ChainError('ARCHIVE_DIFFERS', `block ${options.atBlock} is not finalized on the source: no archive is built from it`);
  }
  const block = options.atBlock !== undefined ? BigInt(options.atBlock) : finalized;
  const read = <T>(what: string, run: (client: PublicClient) => Promise<T>) => readOnBoth(clients, what, run);

  const anchored: { recordId: Hex; txHash: Hash; blockNumber: number }[] = [];
  const known = deps.known && BigInt(deps.known.block) <= block ? deps.known : null;
  for (const r of known?.records ?? []) anchored.push({ recordId: r.recordId.toLowerCase() as Hex, txHash: r.txHash.toLowerCase() as Hash, blockNumber: r.blockNumber });
  const scanFrom = known && known.block + 1 > source.deployBlock ? BigInt(known.block + 1) : BigInt(source.deployBlock);
  const range = BigInt(deps.rangeBlocks ?? RANGE_BLOCKS);
  for (let from = scanFrom; from <= block; from += range) {
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
