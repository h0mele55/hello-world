import { concat, encodeAbiParameters, getAddress, keccak256, toBytes, type Address, type Hash, type Hex, type PublicClient } from 'viem';
import { z } from 'zod';
import { RECORD_KINDS, recordIdFor, type RegistryRecord } from '../chain/records';
import { registryAbi } from '../chain/registry-artifact';
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
 * Isomorphic: no server imports.
 */

export const ARCHIVE_FORMAT = 'reanchor-archive/1';
export const PROOF_FORMAT = 'reanchor-proof/1';
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

/** An archive or a proof whose records hash to its root; not yet held to any chain. */
export interface CheckedSet extends ReanchorEnds {
  root: Hex;
  count: number;
  /** True for an archive: every record under the root is here. */
  complete: boolean;
  issuers: Record<string, string>;
  records: ArchivedRecord[];
}

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
const ProofSchema = z
  .object({
    format: z.literal(PROOF_FORMAT),
    ...Ends,
    count: z
      .number()
      .int()
      .positive()
      .max(2 ** 32 - 1),
    records: z
      .array(z.object({ record: ArchivedRecordSchema, proof: z.array(Bytes32).max(64) }).strict())
      .min(1)
      .max(3),
  })
  .strict();
const SetSchema = z.discriminatedUnion('format', [ArchiveSchema, ProofSchema]);

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const invalid = (detail: string): never => {
  throw new CannotVerify('REANCHOR_PROOF_INVALID', detail);
};

/**
 * An archive or a proof, read from untrusted JSON and held to its own root:
 * every record id is the source registry's id for its fields, every issuer
 * name is the one its org id is the hash of, and (for an archive) every
 * family's latest is the family's highest version. Any doubt is
 * REANCHOR_PROOF_INVALID with what failed; nothing here reads a chain.
 */
export function checkReanchorSet(input: unknown): CheckedSet {
  const parsed = SetSchema.safeParse(input);
  if (!parsed.success) return invalid(`not a re-anchor archive or proof: ${parsed.error.issues[0]?.path.join('.') || 'format'}`);
  const file = parsed.data;
  const { source, target } = file;
  if (source.chainId === target.chainId && same(source.registry, target.registry)) invalid('a registry re-anchored onto itself');
  for (const [orgId, name] of Object.entries(file.issuers)) {
    if (!same(keccak256(toBytes(name)), orgId)) invalid(`the issuer name given for ${orgId} is not the one it was made from`);
  }
  const records = file.format === ARCHIVE_FORMAT ? file.records : file.records.map((entry) => entry.record);
  for (const r of records) {
    if (!same(recordIdFor(source.chainId, source.registry, r.familyId, r.version, r.kind), r.recordId)) invalid(`${r.recordId} is not the source registry's id for its fields`);
    if (r.blockNumber > source.block) invalid(`${r.recordId} is from after the snapshot`);
    if (r.revoked && r.revokeReason === 0) invalid(`${r.recordId} is revoked with no reason`);
  }
  if (new Set(records.map((r) => r.recordId)).size !== records.length) invalid('the same record twice');

  if (file.format === ARCHIVE_FORMAT) {
    if (merkleRoot(records.map((r) => leafOf(source, r))) !== file.root) invalid('the records do not hash to the root');
    const latest = new Map<Hex, ArchivedRecord>();
    for (const r of records) {
      const held = latest.get(r.familyId);
      if (r.kind === 'ORIGINAL' && (!held || r.version > held.version)) latest.set(r.familyId, r);
    }
    for (const r of records) {
      if (latest.get(r.familyId)?.recordId !== r.familyLatest) invalid(`${r.recordId} does not name its family's latest version`);
    }
    return { source, target, root: file.root, count: records.length, complete: true, issuers: lowerKeys(file.issuers), records };
  }
  for (const { record, proof } of file.records) {
    if (rootFromProof(leafOf(source, record), proof) !== file.root) invalid(`the proof of ${record.recordId} does not lead to the root`);
  }
  return { source, target, root: file.root, count: file.count, complete: false, issuers: lowerKeys(file.issuers), records };
}

const lowerKeys = (issuers: Record<string, string>) => Object.fromEntries(Object.entries(issuers).map(([k, v]) => [k.toLowerCase(), v]));

/** An archive of `records`, for the build script. */
export function archiveOf(ends: ReanchorEnds, records: ArchivedRecord[], issuers: Record<string, string>): ReanchorArchive {
  return { format: ARCHIVE_FORMAT, ...ends, root: merkleRoot(records.map((r) => leafOf(ends.source, r))), issuers, records };
}

/**
 * Every record's proof, the tree built once: the record, its original when it
 * is a copy, and its family's latest, each with its path to the root, so a
 * verifier holding one proof can say all a verdict needs about that file.
 */
export function proofsOf(archive: ReanchorArchive): ReanchorProof[] {
  const byId = new Map(archive.records.map((r) => [r.recordId, r]));
  const tree = merkleTree(archive.records.map((r) => leafOf(archive.source, r)));
  if (tree.root !== archive.root) invalid('the records do not hash to the root');
  return archive.records.map((record) => {
    const ids = new Set<Hex>([record.recordId, record.familyLatest]);
    if (record.kind === 'DISTRIBUTION_COPY') ids.add(record.parentId);
    const included = [...ids].map((id) => byId.get(id) ?? invalid(`${id} is not in the archive`));
    const orgs = new Set(included.map((r) => r.orgId).filter((o): o is Hex => o !== null));
    return {
      format: PROOF_FORMAT,
      source: archive.source,
      target: archive.target,
      root: archive.root,
      count: archive.records.length,
      issuers: Object.fromEntries(Object.entries(archive.issuers).filter(([orgId]) => orgs.has(orgId.toLowerCase() as Hex))),
      records: included.map((r) => ({ record: r, proof: tree.proof(leafOf(archive.source, r)) })),
    };
  });
}

// ── The chain ──

/**
 * The root, as the registry the verifier reads holds it: the same root, source
 * registry, snapshot block and count, not voided, at a finalized block both
 * endpoints agree on. Anything else is REANCHOR_ROOT_NOT_RECORDED.
 */
export async function findRecordedRoot(set: CheckedSet, config: VerifierConfig, clients: readonly PublicClient[] = clientsFor(config)): Promise<RecordedRoot> {
  if (set.target.chainId !== config.chainId || !same(set.target.registry, config.registry)) {
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
  // A proof holds a few records; asked about another, it cannot say there is none.
  const notHeld = (what: string): null => {
    if (set.complete) return null;
    throw new CannotVerify('REANCHOR_NOT_COVERED', what);
  };
  return {
    blockNumber: BigInt(set.source.block),
    async getRecord(recordId) {
      return byId.get(recordId.toLowerCase() as Hex) ?? notHeld(`record ${recordId}`);
    },
    async findByDocHash(docHash) {
      return byDoc.get(docHash.toLowerCase() as Hex) ?? null;
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
      if (!record) throw new CannotVerify('REANCHOR_NOT_COVERED', `block ${block}`);
      return record.blockTime;
    },
    async anchoringTx(recordId) {
      return byId.get(recordId.toLowerCase() as Hex)?.txHash ?? null;
    },
  };
}

export interface Reanchored extends RecordedRoot {
  /** The registry the root was found in: the one the verifier reads. */
  targetChainId: number;
  targetRegistry: Address;
  /** Display names of the source's issuers, each checked against its org id. */
  issuers: Record<string, string>;
}

/**
 * The verdict on a file, from the verifier's own registry or, when that holds
 * no record of it, from a re-anchored set whose source registry the file names
 * or whose records hold it exactly. A set is used only through its root on the
 * verifier's registry; until then the verdict is CANNOT_VERIFY with the reason.
 */
export async function verifyWithReanchors(input: {
  bytes: Uint8Array;
  config: VerifierConfig;
  openView: () => Promise<RegistryView>;
  readPdf: (bytes: Uint8Array) => Promise<DocumentRead>;
  sets: readonly CheckedSet[];
  clients?: readonly PublicClient[];
}): Promise<{ verdict: Verdict; reanchored: Reanchored | null }> {
  const primary = await verifyFile(input);
  if ((primary.kind !== 'NOT_REGISTERED' && primary.kind !== 'UNKNOWN_REGISTRY') || input.sets.length === 0) return { verdict: primary, reanchored: null };
  const holds = (set: CheckedSet) => set.records.some((r) => r.docHash === primary.docHash);
  const named = (set: CheckedSet) => primary.kind === 'UNKNOWN_REGISTRY' && primary.claimedChainId === set.source.chainId && same(primary.claimedContract, set.source.registry);
  // A set holding the very file first, then whole archives before single proofs.
  const candidates = input.sets.filter((set) => holds(set) || named(set)).sort((a, b) => Number(holds(b)) - Number(holds(a)) || Number(b.complete) - Number(a.complete));
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
  return { verdict, reanchored: found ? { ...found, targetChainId: input.config.chainId, targetRegistry: input.config.registry, issuers: set.issuers } : null };
}
