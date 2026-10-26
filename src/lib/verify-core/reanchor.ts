import { bytesToHex, concat, encodeAbiParameters, getAddress, hexToBytes, keccak256, sha256, toBytes, type Address, type Hash, type Hex, type PublicClient } from 'viem';
import { z } from 'zod';
import { RECORD_KINDS, recordIdFor, type RegistryRecord } from '../chain/records';
import { registryAbi } from '../chain/registry-artifact';
import { BitcoinError, bitcoinTimeOf, type BitcoinTime, type HeaderCache } from '../ots/bitcoin';
import { OtsError, parseProof, type Proof } from '../ots/format';
import { defaultExplorers } from './bitcoin-timestamp';
import { docHashOf } from './commitment';
import type { DocumentRead } from './document';
import { both, CannotVerify, checkEndpoints, clientsFor, type RegistryView, type VerifierConfig } from './registry-view';
import { verifyFile, type Verdict } from './verdict';

/**
 * Re-anchoring (#65). Before a chain is shut down, every record its registry
 * held at one finalized block goes into a Merkle tree, and the registry's
 * owner records the tree's root on another deployment of the registry
 * (`recordReanchorRoot`). A record then stays verifiable without its chain:
 *
 *   archive  every record of the snapshot. Its root is recomputed from all of
 *            them, so it also answers "what is this family's latest version?"
 *            and "is there such a record?".
 *   proof    one record, with its original (for a copy) and its family's
 *            latest at the snapshot, each with its path to the root. It
 *            answers for those records only; asked about any other, it says
 *            so rather than answer (REANCHOR_NOT_COVERED).
 *
 * Either is accepted only once the root is found, not voided, in the registry
 * the verifier reads, at a finalized block both endpoints agree on, for the
 * same source registry, snapshot block and record count. Each leaf commits to
 * the whole record as the source registry returned it at the snapshot, and to
 * what a verifier shows about it (its block's time, its transaction, its
 * issuer's org, its family's latest), so nothing shown is taken on trust.
 *
 * A checkpoint (#122) is the same tree over a registry that is still live:
 * once a month the firm's records, read at a finalized block, and its root
 * timestamped on Bitcoin through OpenTimestamps instead of recorded on a
 * registry. What is timestamped is the checkpoint's head: which registry, at
 * which block, for which month, how many records, under which root, so no two
 * months share a timestamp even when no record was added between them, and the
 * reference client checks it against a file holding just the head. A
 * checkpoint answers for the day the registry cannot be read, and only as of
 * its block: a record it does not hold may have come after it, so it never
 * says "none" (CHECKPOINT_NOT_COVERED).
 * Isomorphic: no server imports.
 */

export const ARCHIVE_FORMAT = 'reanchor-archive/1';
export const PROOF_FORMAT = 'reanchor-proof/1';
export const CHECKPOINT_FORMAT = 'checkpoint/1';
export const CHECKPOINT_PROOF_FORMAT = 'checkpoint-proof/1';
/** A domain tag, so a leaf can never be read as any other hash of the same fields. */
const LEAF_TAG = keccak256(toBytes('audit-anchor/reanchor-leaf/1'));
const MAX_RECORDS = 200_000;
const ROOT_PAGE = 500n;

/** A record as the source registry held it at the snapshot, and what a verifier shows about it. */
export interface ArchivedRecord extends RegistryRecord {
  /** Unix seconds of the record's block. */
  blockTime: number;
  /** The transaction whose Anchored event created it. */
  txHash: Hash;
  /** The issuer key's org at the snapshot, or null when the key was not registered. */
  orgId: Hex | null;
  /** The family's latest ORIGINAL at the snapshot. */
  familyLatest: Hex;
}

export interface ReanchorEnds {
  /** The deployment the records were read from, and the finalized block they were read at. */
  source: { chainId: number; registry: Address; block: number };
  /** The deployment whose owner records the root. */
  target: { chainId: number; registry: Address };
}

export interface ReanchorArchive extends ReanchorEnds {
  format: typeof ARCHIVE_FORMAT;
  root: Hex;
  /** Lower-case org id -> the name it is the keccak256 of, for display. */
  issuers: Record<string, string>;
  records: ArchivedRecord[];
}

export interface ReanchorProof extends ReanchorEnds {
  format: typeof PROOF_FORMAT;
  root: Hex;
  /** How many records are under the root. */
  count: number;
  issuers: Record<string, string>;
  records: { record: ArchivedRecord; proof: Hex[] }[];
}

export interface Checkpoint {
  format: typeof CHECKPOINT_FORMAT;
  source: ReanchorEnds['source'];
  /** The month it closes, YYYY-MM in UTC. */
  period: string;
  root: Hex;
  issuers: Record<string, string>;
  records: ArchivedRecord[];
  /** The OpenTimestamps proof of sha256(head), base64; null until it is complete. */
  ots: string | null;
}

export interface CheckpointProof {
  format: typeof CHECKPOINT_PROOF_FORMAT;
  source: ReanchorEnds['source'];
  period: string;
  root: Hex;
  count: number;
  issuers: Record<string, string>;
  records: { record: ArchivedRecord; proof: Hex[] }[];
  ots: string | null;
}

/** An archive, a checkpoint or a proof of either, whose records hash to its root; not yet held to any chain. */
export interface CheckedSet {
  source: ReanchorEnds['source'];
  /** For a re-anchor set: the registry its root must be recorded on. */
  target: ReanchorEnds['target'] | null;
  /** For a checkpoint: its month, and its Bitcoin timestamp if it carries one. */
  checkpoint: { period: string; ots: Uint8Array | null } | null;
  root: Hex;
  count: number;
  /** True for an archive or a checkpoint: every record under the root is here. */
  complete: boolean;
  issuers: Record<string, string>;
  records: ArchivedRecord[];
}

const HEAD_TAG = keccak256(toBytes('audit-anchor/checkpoint-head/1'));
const HEAD_TYPES = [{ type: 'bytes32' }, { type: 'uint64' }, { type: 'address' }, { type: 'uint40' }, { type: 'string' }, { type: 'uint32' }, { type: 'bytes32' }] as const;

export interface CheckpointHeadFields {
  source: ReanchorEnds['source'];
  period: string;
  count: number;
  root: Hex;
}

/** The bytes a checkpoint's timestamp is of: which registry, at which block, for which month, how many records, under which root. */
export function checkpointHead(c: CheckpointHeadFields): Uint8Array {
  return hexToBytes(encodeAbiParameters(HEAD_TYPES, [HEAD_TAG, BigInt(c.source.chainId), getAddress(c.source.registry), c.source.block, c.period, c.count, c.root]));
}

/** The digest a checkpoint's timestamp is of: the SHA-256 of its head. */
export const checkpointDigest = (c: CheckpointHeadFields): Hex => sha256(checkpointHead(c));

/** A root as the registry holds it. */
export interface RecordedRoot {
  index: number;
  root: Hex;
  sourceChainId: number;
  sourceRegistry: Address;
  sourceBlock: number;
  count: number;
  /** The block of the verifier's chain it was recorded in. */
  recordedBlock: number;
}

// ── Leaves and the tree ──

const LEAF_TYPES = [
  { type: 'bytes32' },
  { type: 'uint64' },
  { type: 'address' },
  { type: 'bytes32' },
  { type: 'bytes32' },
  { type: 'bytes32' },
  { type: 'bytes32' },
  { type: 'bytes32' },
  { type: 'bytes32' },
  { type: 'address' },
  { type: 'uint40' },
  { type: 'uint32' },
  { type: 'uint8' },
  { type: 'bool' },
  { type: 'uint8' },
  { type: 'uint40' },
  { type: 'uint40' },
  { type: 'bytes32' },
  { type: 'bytes32' },
  { type: 'bytes32' },
] as const;

const ZERO = `0x${'0'.repeat(64)}` as Hex;

/** The leaf of one record: hashed twice, so no inner node of the tree can pass for a leaf. */
export function leafOf(source: { chainId: number; registry: Address }, r: ArchivedRecord): Hex {
  const encoded = encodeAbiParameters(LEAF_TYPES, [
    LEAF_TAG,
    BigInt(source.chainId),
    source.registry,
    r.recordId,
    r.familyId,
    r.docHash,
    r.manifestHash,
    r.opinionCommitment,
    r.parentId,
    r.issuer,
    r.blockNumber,
    r.version,
    RECORD_KINDS.indexOf(r.kind),
    r.revoked,
    r.revokeReason,
    r.revokeEffectiveAt,
    r.blockTime,
    r.txHash,
    r.orgId ?? ZERO,
    r.familyLatest,
  ]);
  return keccak256(keccak256(encoded));
}

/** Two nodes in order, so a proof needs no left or right: lower-case hex sorts as the bytes do. */
const parentOf = (a: Hex, b: Hex) => keccak256(concat(a < b ? [a, b] : [b, a]));

function levels(leaves: readonly Hex[]): Hex[][] {
  if (leaves.length === 0) throw new CannotVerify('REANCHOR_PROOF_INVALID', 'a tree of no records');
  const first = leaves.map((l) => l.toLowerCase() as Hex).sort();
  if (first.some((leaf, i) => i > 0 && leaf === first[i - 1])) throw new CannotVerify('REANCHOR_PROOF_INVALID', 'the same record twice');
  const all = [first];
  while (all[all.length - 1].length > 1) {
    const level = all[all.length - 1];
    const next: Hex[] = [];
    // An odd node out moves up unchanged.
    for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? parentOf(level[i], level[i + 1]) : level[i]);
    all.push(next);
  }
  return all;
}

/** The tree over a set of leaves: its root, and each leaf's path to it (the siblings, from the bottom). */
export function merkleTree(leaves: readonly Hex[]): { root: Hex; proof(leaf: Hex): Hex[] } {
  const all = levels(leaves);
  const position = new Map(all[0].map((leaf, i) => [leaf, i]));
  return {
    root: all[all.length - 1][0],
    proof(leaf) {
      let index = position.get(leaf.toLowerCase() as Hex);
      if (index === undefined) throw new CannotVerify('REANCHOR_PROOF_INVALID', 'the leaf is not in the tree');
      const proof: Hex[] = [];
      for (const level of all.slice(0, -1)) {
        const sibling = index ^ 1;
        if (sibling < level.length) proof.push(level[sibling]);
        index >>= 1;
      }
      return proof;
    },
  };
}

export const merkleRoot = (leaves: readonly Hex[]): Hex => merkleTree(leaves).root;

export const rootFromProof = (leaf: Hex, proof: readonly Hex[]): Hex => proof.reduce<Hex>((node, sibling) => parentOf(node, sibling.toLowerCase() as Hex), leaf.toLowerCase() as Hex);

// ── Files ──

const Bytes32 = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .transform((s) => s.toLowerCase() as Hex);
const AddressField = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((a) => getAddress(a));
const Uint40 = z
  .number()
  .int()
  .nonnegative()
  .max(2 ** 40 - 1);
const ChainId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

const ArchivedRecordSchema = z
  .object({
    recordId: Bytes32,
    familyId: Bytes32,
    docHash: Bytes32,
    manifestHash: Bytes32,
    opinionCommitment: Bytes32,
    parentId: Bytes32,
    issuer: AddressField,
    blockNumber: Uint40,
    version: z
      .number()
      .int()
      .positive()
      .max(2 ** 32 - 1),
    kind: z.enum(RECORD_KINDS),
    revoked: z.boolean(),
    revokeReason: z.number().int().nonnegative().max(255),
    revokeEffectiveAt: Uint40,
    blockTime: Uint40,
    txHash: Bytes32,
    orgId: Bytes32.nullable(),
    familyLatest: Bytes32,
  })
  .strict();

const Ends = {
  source: z.object({ chainId: ChainId, registry: AddressField, block: Uint40.positive() }).strict(),
  target: z.object({ chainId: ChainId, registry: AddressField }).strict(),
  root: Bytes32,
  issuers: z.record(z.string(), z.string().min(1).max(200)),
};

const ArchiveSchema = z.object({ format: z.literal(ARCHIVE_FORMAT), ...Ends, records: z.array(ArchivedRecordSchema).min(1).max(MAX_RECORDS) }).strict();
const CheckpointFields = {
  source: Ends.source,
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  root: Bytes32,
  issuers: Ends.issuers,
  ots: z
    .string()
    .regex(/^[A-Za-z0-9+/]+={0,2}$/)
    .max(64 * 1024)
    .nullable(),
};
const CheckpointSchema = z.object({ format: z.literal(CHECKPOINT_FORMAT), ...CheckpointFields, records: z.array(ArchivedRecordSchema).min(1).max(MAX_RECORDS) }).strict();
const ProofEntries = z
  .array(z.object({ record: ArchivedRecordSchema, proof: z.array(Bytes32).max(64) }).strict())
  .min(1)
  .max(3);
const ProofSchema = z
  .object({
    format: z.literal(PROOF_FORMAT),
    ...Ends,
    count: z
      .number()
      .int()
      .positive()
      .max(2 ** 32 - 1),
    records: ProofEntries,
  })
  .strict();
const CheckpointProofSchema = z
  .object({
    format: z.literal(CHECKPOINT_PROOF_FORMAT),
    ...CheckpointFields,
    count: z
      .number()
      .int()
      .positive()
      .max(2 ** 32 - 1),
    records: ProofEntries,
  })
  .strict();
const SetSchema = z.discriminatedUnion('format', [ArchiveSchema, ProofSchema, CheckpointSchema, CheckpointProofSchema]);

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const invalid = (detail: string): never => {
  throw new CannotVerify('REANCHOR_PROOF_INVALID', detail);
};

const fromBase64 = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/**
 * An archive, a checkpoint or a proof of either, read from untrusted JSON and
 * held to its own root: every record id is the source registry's id for its
 * fields, every issuer name is the one its org id is the hash of, and (for an
 * archive or a checkpoint) every family's latest is the family's highest
 * version. Any doubt is REANCHOR_PROOF_INVALID with what failed; nothing here
 * reads a chain, and a checkpoint's timestamp is checked later, against Bitcoin.
 */
export function checkReanchorSet(input: unknown): CheckedSet {
  const parsed = SetSchema.safeParse(input);
  if (!parsed.success) return invalid(`not a re-anchor archive, a checkpoint or a proof: ${parsed.error.issues[0]?.path.join('.') || 'format'}`);
  const file = parsed.data;
  const { source } = file;
  const target = 'target' in file ? file.target : null;
  const checkpoint = 'period' in file ? { period: file.period, ots: file.ots === null ? null : fromBase64(file.ots) } : null;
  if (target && source.chainId === target.chainId && same(source.registry, target.registry)) invalid('a registry re-anchored onto itself');
  for (const [orgId, name] of Object.entries(file.issuers)) {
    if (!same(keccak256(toBytes(name)), orgId)) invalid(`the issuer name given for ${orgId} is not the one it was made from`);
  }
  const whole = file.format === ARCHIVE_FORMAT || file.format === CHECKPOINT_FORMAT;
  const records = whole ? file.records : file.records.map((entry) => entry.record);
  for (const r of records) {
    if (!same(recordIdFor(source.chainId, source.registry, r.familyId, r.version, r.kind), r.recordId)) invalid(`${r.recordId} is not the source registry's id for its fields`);
    if (r.blockNumber > source.block) invalid(`${r.recordId} is from after the snapshot`);
    if (r.revoked && r.revokeReason === 0) invalid(`${r.recordId} is revoked with no reason`);
  }
  if (new Set(records.map((r) => r.recordId)).size !== records.length) invalid('the same record twice');
  const set = { source, target, checkpoint, root: file.root, issuers: lowerKeys(file.issuers), records };

  if (whole) {
    if (merkleRoot(records.map((r) => leafOf(source, r))) !== file.root) invalid('the records do not hash to the root');
    const latest = new Map<Hex, ArchivedRecord>();
    for (const r of records) {
      const held = latest.get(r.familyId);
      if (r.kind === 'ORIGINAL' && (!held || r.version > held.version)) latest.set(r.familyId, r);
    }
    for (const r of records) {
      if (latest.get(r.familyId)?.recordId !== r.familyLatest) invalid(`${r.recordId} does not name its family's latest version`);
    }
    return { ...set, count: records.length, complete: true };
  }
  for (const { record, proof } of file.records) {
    if (rootFromProof(leafOf(source, record), proof) !== file.root) invalid(`the proof of ${record.recordId} does not lead to the root`);
  }
  return { ...set, count: file.count, complete: false };
}

const lowerKeys = (issuers: Record<string, string>) => Object.fromEntries(Object.entries(issuers).map(([k, v]) => [k.toLowerCase(), v]));

/** An archive of `records`, for the build script. */
export function archiveOf(ends: ReanchorEnds, records: ArchivedRecord[], issuers: Record<string, string>): ReanchorArchive {
  return { format: ARCHIVE_FORMAT, ...ends, root: merkleRoot(records.map((r) => leafOf(ends.source, r))), issuers, records };
}

/** A month's checkpoint of `records`, its timestamp still to come. */
export function checkpointOf(source: ReanchorEnds['source'], period: string, records: ArchivedRecord[], issuers: Record<string, string>): Checkpoint {
  return { format: CHECKPOINT_FORMAT, source, period, root: merkleRoot(records.map((r) => leafOf(source, r))), issuers, records, ots: null };
}

/**
 * Every record's proof, the tree built once: the record, its original when it
 * is a copy, and its family's latest, each with its path to the root, so a
 * verifier holding one proof can say all a verdict needs about that file.
 */
export function proofsOf(archive: ReanchorArchive): ReanchorProof[];
export function proofsOf(archive: Checkpoint): CheckpointProof[];
export function proofsOf(archive: ReanchorArchive | Checkpoint): (ReanchorProof | CheckpointProof)[] {
  const byId = new Map(archive.records.map((r) => [r.recordId, r]));
  const tree = merkleTree(archive.records.map((r) => leafOf(archive.source, r)));
  if (tree.root !== archive.root) invalid('the records do not hash to the root');
  return archive.records.map((record) => {
    const ids = new Set<Hex>([record.recordId, record.familyLatest]);
    if (record.kind === 'DISTRIBUTION_COPY') ids.add(record.parentId);
    const included = [...ids].map((id) => byId.get(id) ?? invalid(`${id} is not in the archive`));
    const orgs = new Set(included.map((r) => r.orgId).filter((o): o is Hex => o !== null));
    const common = {
      source: archive.source,
      root: archive.root,
      count: archive.records.length,
      issuers: Object.fromEntries(Object.entries(archive.issuers).filter(([orgId]) => orgs.has(orgId.toLowerCase() as Hex))),
      records: included.map((r) => ({ record: r, proof: tree.proof(leafOf(archive.source, r)) })),
    };
    return archive.format === ARCHIVE_FORMAT
      ? { format: PROOF_FORMAT, ...common, target: archive.target }
      : { format: CHECKPOINT_PROOF_FORMAT, ...common, period: archive.period, ots: archive.ots };
  });
}

// ── The chain ──

/**
 * The root, as the registry the verifier reads holds it: the same root, source
 * registry, snapshot block and count, not voided, at a finalized block both
 * endpoints agree on. Anything else is REANCHOR_ROOT_NOT_RECORDED.
 */
export async function findRecordedRoot(set: CheckedSet, config: VerifierConfig, clients: readonly PublicClient[] = clientsFor(config)): Promise<RecordedRoot> {
  if (!set.target || set.target.chainId !== config.chainId || !same(set.target.registry, config.registry)) {
    throw new CannotVerify('REANCHOR_ROOT_NOT_RECORDED', 'the root was recorded on another registry than this verifier reads');
  }
  const blockNumber = await checkEndpoints(config, clients);
  const at = { address: config.registry, abi: registryAbi, blockNumber } as const;
  const total = await both(clients, (c) => c.readContract({ ...at, functionName: 'reanchorRootCount' }));
  let voided = false;
  for (let start = 0n; start < total; start += ROOT_PAGE) {
    const page = await both(clients, (c) => c.readContract({ ...at, functionName: 'reanchorRoots', args: [start, ROOT_PAGE] }));
    for (const [i, entry] of page.entries()) {
      const matches =
        same(entry.root, set.root) &&
        Number(entry.sourceChainId) === set.source.chainId &&
        same(entry.sourceRegistry, set.source.registry) &&
        entry.sourceBlock === set.source.block &&
        entry.count === set.count;
      if (!matches) continue;
      if (entry.voided) {
        voided = true;
        continue;
      }
      return {
        index: Number(start) + i,
        root: set.root,
        sourceChainId: set.source.chainId,
        sourceRegistry: set.source.registry,
        sourceBlock: set.source.block,
        count: set.count,
        recordedBlock: entry.recordedBlock,
      };
    }
  }
  throw new CannotVerify('REANCHOR_ROOT_NOT_RECORDED', voided ? 'the owner voided the root' : 'the registry holds no such root');
}

/** The source registry as it stood at the snapshot, answered from a checked set. */
export function archivedView(set: CheckedSet): RegistryView {
  const byId = new Map(set.records.map((r) => [r.recordId, r]));
  const byDoc = new Map(set.records.map((r) => [r.docHash, r]));
  // Only a whole re-anchor archive, of a registry that took no record after it, can say there is none.
  const answersAbsence = set.complete && !set.checkpoint;
  const reason = set.checkpoint ? 'CHECKPOINT_NOT_COVERED' : 'REANCHOR_NOT_COVERED';
  const notHeld = (what: string): null => {
    if (answersAbsence) return null;
    throw new CannotVerify(reason, what);
  };
  return {
    blockNumber: BigInt(set.source.block),
    async getRecord(recordId) {
      return byId.get(recordId.toLowerCase() as Hex) ?? notHeld(`record ${recordId}`);
    },
    async findByDocHash(docHash) {
      // A file a checkpoint does not hold may have been anchored after it.
      return byDoc.get(docHash.toLowerCase() as Hex) ?? (set.checkpoint ? notHeld(`file ${docHash}`) : null);
    },
    async latestOf(familyId) {
      const member = set.records.find((r) => r.familyId === familyId.toLowerCase());
      if (!member) return notHeld(`family ${familyId}`);
      return byId.get(member.familyLatest) ?? notHeld(`the latest version of family ${familyId}`);
    },
    async issuerOrg(issuer) {
      return set.records.find((r) => same(r.issuer, issuer))?.orgId ?? null;
    },
    async blockTime(block) {
      const record = set.records.find((r) => BigInt(r.blockNumber) === block);
      if (!record) throw new CannotVerify(reason, `block ${block}`);
      return record.blockTime;
    },
    async anchoringTx(recordId) {
      return byId.get(recordId.toLowerCase() as Hex)?.txHash ?? null;
    },
  };
}

// ── A checkpoint's Bitcoin timestamp ──

/** The Bitcoin check of a timestamp: the block its path reaches, null while it reaches none. */
export type CheckpointBitcoinCheck = (proof: Proof) => Promise<BitcoinTime | null>;

/** Against the two block explorers every verifier reads (#66). */
export function explorerCheck(): CheckpointBitcoinCheck {
  const cache: HeaderCache = new Map();
  const sources = defaultExplorers();
  return (proof) => bitcoinTimeOf(proof, sources, cache);
}

/**
 * The Bitcoin block a checkpoint is timestamped in: its OpenTimestamps proof
 * must be of the SHA-256 of its head, and its path must reach a block both
 * explorers agree on. Anything short of that is CHECKPOINT_UNPROVEN, with why.
 */
export async function provenCheckpoint(set: CheckedSet, check: CheckpointBitcoinCheck = explorerCheck()): Promise<BitcoinTime> {
  const unproven = (detail: string) => new CannotVerify('CHECKPOINT_UNPROVEN', detail);
  if (!set.checkpoint) throw unproven('not a checkpoint');
  if (!set.checkpoint.ots) throw unproven('the checkpoint carries no Bitcoin timestamp yet');
  let proof: Proof;
  try {
    proof = parseProof(set.checkpoint.ots);
  } catch (error) {
    if (error instanceof OtsError) throw unproven(`the timestamp cannot be read: ${error.code}`);
    throw error;
  }
  const digest = checkpointDigest({ source: set.source, period: set.checkpoint.period, count: set.count, root: set.root });
  if (bytesToHex(proof.digest) !== digest) throw unproven('the timestamp is of something else than this checkpoint');
  let reached: BitcoinTime | null;
  try {
    reached = await check(proof);
  } catch (error) {
    if (error instanceof BitcoinError) throw unproven(`the Bitcoin check failed: ${error.code}`);
    throw error;
  }
  if (!reached) throw unproven('the timestamp does not reach a Bitcoin block yet');
  return reached;
}

export type Reanchored =
  /** Through a root recorded on the verifier's registry (#65). */
  | (RecordedRoot & {
      kind: 'registry';
      /** The registry the root was found in: the one the verifier reads. */
      targetChainId: number;
      targetRegistry: Address;
      /** Display names of the source's issuers, each checked against its org id. */
      issuers: Record<string, string>;
    })
  /** Through a checkpoint of the verifier's own registry, timestamped on Bitcoin (#122): what it held at `sourceBlock`. */
  | {
      kind: 'checkpoint';
      period: string;
      root: Hex;
      sourceChainId: number;
      sourceRegistry: Address;
      sourceBlock: number;
      count: number;
      bitcoin: BitcoinTime;
      issuers: Record<string, string>;
    };

/**
 * The verdict on a file, from the verifier's own registry, or from a set when
 * that registry cannot answer:
 *
 *   - it holds no record of the file: a re-anchored set whose source registry
 *     the file names or whose records hold it exactly, used only through its
 *     root on the verifier's registry (#65);
 *   - it cannot be reached: the latest checkpoint of that same registry, used
 *     only through its Bitcoin timestamp, and answering as of its block (#122).
 *
 * Until a set is proven, the verdict is CANNOT_VERIFY with the reason.
 */
export async function verifyWithReanchors(input: {
  bytes: Uint8Array;
  config: VerifierConfig;
  openView: () => Promise<RegistryView>;
  readPdf: (bytes: Uint8Array) => Promise<DocumentRead>;
  sets: readonly CheckedSet[];
  clients?: readonly PublicClient[];
  bitcoinCheck?: CheckpointBitcoinCheck;
}): Promise<{ verdict: Verdict; reanchored: Reanchored | null }> {
  const primary = await verifyFile(input);
  const docHash = docHashOf(input.bytes);
  const holds = (set: CheckedSet) => set.records.some((r) => r.docHash === docHash);

  if (primary.kind === 'CANNOT_VERIFY' && primary.reason === 'RPC_UNREACHABLE') {
    const ofThisRegistry = input.sets.filter((set) => set.checkpoint && set.source.chainId === input.config.chainId && same(set.source.registry, input.config.registry));
    // One holding the very file first, then the latest, then a whole checkpoint before a proof.
    const set = [...ofThisRegistry].sort((a, b) => Number(holds(b)) - Number(holds(a)) || b.source.block - a.source.block || Number(b.complete) - Number(a.complete))[0];
    if (!set?.checkpoint) return { verdict: primary, reanchored: null };
    let bitcoin: BitcoinTime | null = null;
    const verdict = await verifyFile({
      bytes: input.bytes,
      config: input.config,
      readPdf: input.readPdf,
      openView: async () => {
        bitcoin = await provenCheckpoint(set, input.bitcoinCheck);
        return archivedView(set);
      },
    });
    const reached = bitcoin as BitcoinTime | null;
    if (verdict.kind === 'CANNOT_VERIFY' || !reached) return { verdict, reanchored: null };
    return {
      verdict,
      reanchored: { kind: 'checkpoint', period: set.checkpoint.period, root: set.root, sourceChainId: set.source.chainId, sourceRegistry: set.source.registry, sourceBlock: set.source.block, count: set.count, bitcoin: reached, issuers: set.issuers },
    };
  }

  if ((primary.kind !== 'NOT_REGISTERED' && primary.kind !== 'UNKNOWN_REGISTRY') || input.sets.length === 0) return { verdict: primary, reanchored: null };
  const named = (set: CheckedSet) => primary.kind === 'UNKNOWN_REGISTRY' && primary.claimedChainId === set.source.chainId && same(primary.claimedContract, set.source.registry);
  // A set holding the very file first, then whole archives before single proofs.
  const candidates = input.sets.filter((set) => set.target && (holds(set) || named(set))).sort((a, b) => Number(holds(b)) - Number(holds(a)) || Number(b.complete) - Number(a.complete));
  const set = candidates[0];
  if (!set) return { verdict: primary, reanchored: null };
  let recorded: RecordedRoot | null = null;
  const verdict = await verifyFile({
    bytes: input.bytes,
    config: set.source,
    readPdf: input.readPdf,
    openView: async () => {
      recorded = await findRecordedRoot(set, input.config, input.clients ?? clientsFor(input.config));
      return archivedView(set);
    },
  });
  const found = recorded as RecordedRoot | null;
  return { verdict, reanchored: found ? { kind: 'registry', ...found, targetChainId: input.config.chainId, targetRegistry: input.config.registry, issuers: set.issuers } : null };
}
