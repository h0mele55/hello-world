import { hexToBytes, type Address, type Hash, type Hex } from 'viem';
import type { RegistryRecord } from '../chain/records';
import { locateOpinion } from '../opinion/locate';
import { dropRunningLines } from '../opinion/normalise';
import { readStamp } from '../stamp-fields';
import { docHashOf, opinionCommitmentOf } from './commitment';
import type { DocumentRead } from './document';
import { CannotVerify, type CannotVerifyReason, type RegistryView, type VerifierConfig } from './registry-view';

/**
 * What a dropped file proves, decided only from the file's own bytes and two
 * agreeing reads of the chain (CLAUDE.md rules 4, 5 and 7). Only an exact-file
 * match is AUTHENTIC; every other verdict says what it does and does not show.
 *
 *   exact match ─┬─ the record or (for a copy) its original revoked ──────────▶ REVOKED
 *                ├─ either with a revocation pending (the registry's delay) ─▶ REVOCATION_PENDING
 *                ├─ the original is its family's latest ────────────────────▶ AUTHENTIC_LATEST
 *                └─ otherwise ───────────────────────────────────────────────▶ AUTHENTIC_SUPERSEDED
 *   no match ────┬─ the file's stamp names this chain and contract, a record that exists:
 *                │    its opinion, recommitted with the stamp's salt, ─ differs ─▶ ALTERED_OPINION_CHANGED
 *                │                                                    ├ equals ──▶ ALTERED_OPINION_APPEARS_UNCHANGED
 *                │                                                    └ unreadable ▶ ALTERED_OPINION_NOT_CHECKABLE
 *                ├─ the stamp names another chain or contract ───────────────▶ UNKNOWN_REGISTRY
 *                └─ no stamp, an unreadable one, or one naming no record ────▶ NOT_REGISTERED
 *   a chain that cannot be read, or two endpoints that disagree ─────────────▶ CANNOT_VERIFY
 */

export interface RecordSummary {
  recordId: Hex;
  kind: RegistryRecord['kind'];
  familyId: Hex;
  version: number;
  docHash: Hex;
  blockNumber: number;
  /** Unix seconds. */
  blockTime: number;
  txHash: Hash | null;
  issuer: Address;
  /** Null when the key is no longer registered. */
  orgId: Hex | null;
  /** In effect at the block read. */
  revoked: boolean;
  /** Non-zero once a revocation was asked for, pending or in effect. */
  revokeReason: number;
  /** When it takes effect, in Unix seconds; zero when none was asked for. */
  revokeEffectiveAt: number;
}

interface Resolved {
  docHash: Hex;
  /** The finalized block the answer was read at. */
  asOfBlock: number;
  original: RecordSummary;
  latest: RecordSummary;
}

export type Verdict =
  | (Resolved & { kind: 'AUTHENTIC_LATEST' | 'AUTHENTIC_SUPERSEDED'; matched: RecordSummary })
  | (Resolved & { kind: 'REVOKED'; matched: RecordSummary; revoked: RecordSummary })
  /** The issuer asked to withdraw it; the registry's owner may still cancel that until `pending.revokeEffectiveAt`. Never authentic. */
  | (Resolved & { kind: 'REVOCATION_PENDING'; matched: RecordSummary; pending: RecordSummary })
  | (Resolved & { kind: 'ALTERED_OPINION_CHANGED' | 'ALTERED_OPINION_APPEARS_UNCHANGED'; claimed: RecordSummary })
  | (Resolved & { kind: 'ALTERED_OPINION_NOT_CHECKABLE'; claimed: RecordSummary; reason: string })
  | { kind: 'UNKNOWN_REGISTRY'; docHash: Hex; asOfBlock: number; claimedChainId: number; claimedContract: Address }
  | { kind: 'NOT_REGISTERED'; docHash: Hex; asOfBlock: number; note: 'NO_REFERENCE' | 'REFERENCE_UNREADABLE' | 'NAMES_UNKNOWN_RECORD' | 'PDF_UNREADABLE' }
  | { kind: 'CANNOT_VERIFY'; reason: CannotVerifyReason | 'FILE_TOO_LARGE' };

export type VerdictKind = Verdict['kind'];

export const MAX_FILE_BYTES = 25 * 1024 * 1024;

export async function verifyFile(input: {
  bytes: Uint8Array;
  config: Pick<VerifierConfig, 'chainId' | 'registry'>;
  openView: () => Promise<RegistryView>;
  readPdf: (bytes: Uint8Array) => Promise<DocumentRead>;
}): Promise<Verdict> {
  if (input.bytes.length > MAX_FILE_BYTES) return { kind: 'CANNOT_VERIFY', reason: 'FILE_TOO_LARGE' };
  const docHash = docHashOf(input.bytes);
  try {
    const view = await input.openView();
    return await decide(view, input, docHash);
  } catch (error) {
    if (error instanceof CannotVerify) return { kind: 'CANNOT_VERIFY', reason: error.reason };
    throw error;
  }
}

async function decide(view: RegistryView, input: Parameters<typeof verifyFile>[0], docHash: Hex): Promise<Verdict> {
  const asOfBlock = Number(view.blockNumber);
  const summaries = new Map<Hex, Promise<RecordSummary>>();
  const summary = (record: RegistryRecord) => {
    if (!summaries.has(record.recordId)) summaries.set(record.recordId, summariseRecord(view, record));
    return summaries.get(record.recordId)!;
  };

  /** The original a record belongs to, and its family's latest; the chain must hold both. */
  async function family(record: RegistryRecord) {
    const original = record.kind === 'DISTRIBUTION_COPY' ? await view.getRecord(record.parentId) : record;
    if (!original || original.kind !== 'ORIGINAL') throw new CannotVerify('CHAIN_INCONSISTENT', 'a copy without its original');
    const latest = await view.latestOf(original.familyId);
    if (!latest) throw new CannotVerify('CHAIN_INCONSISTENT', 'a family without a latest record');
    return { original, latest };
  }

  const matched = await view.findByDocHash(docHash);
  if (matched) {
    const { original, latest } = await family(matched);
    const resolved = { docHash, asOfBlock, original: await summary(original), latest: await summary(latest), matched: await summary(matched) };
    const revoked = [matched, original].find((r) => r.revoked);
    if (revoked) return { kind: 'REVOKED', ...resolved, revoked: await summary(revoked) };
    const pending = [matched, original].find((r) => r.revokeReason !== 0);
    if (pending) return { kind: 'REVOCATION_PENDING', ...resolved, pending: await summary(pending) };
    return { kind: latest.recordId === original.recordId ? 'AUTHENTIC_LATEST' : 'AUTHENTIC_SUPERSEDED', ...resolved };
  }

  // Not this exact file: what does the file say about itself?
  const read = await input.readPdf(input.bytes);
  if (!read.ok) return { kind: 'NOT_REGISTERED', docHash, asOfBlock, note: 'PDF_UNREADABLE' };
  const stamp = readStamp(read.doc.xmp, read.doc.info);
  if (stamp.status === 'NONE') return { kind: 'NOT_REGISTERED', docHash, asOfBlock, note: 'NO_REFERENCE' };
  if (stamp.status === 'MALFORMED') return { kind: 'NOT_REGISTERED', docHash, asOfBlock, note: 'REFERENCE_UNREADABLE' };
  const claim = stamp.fields;
  if (claim.chainId !== input.config.chainId || claim.contract.toLowerCase() !== input.config.registry.toLowerCase()) {
    return { kind: 'UNKNOWN_REGISTRY', docHash, asOfBlock, claimedChainId: claim.chainId, claimedContract: claim.contract as Address };
  }
  const claimedRecord = await view.getRecord(claim.recordId as Hex);
  if (!claimedRecord) return { kind: 'NOT_REGISTERED', docHash, asOfBlock, note: 'NAMES_UNKNOWN_RECORD' };
  const { original, latest } = await family(claimedRecord);
  const resolved = { docHash, asOfBlock, original: await summary(original), latest: await summary(latest), claimed: await summary(claimedRecord) };

  // Recommit to the opinion as this file now reads, with the salt the file carries.
  const located = locateOpinion(dropRunningLines(read.doc.pageLines));
  // A file holding several reports is not checked against one of them: which one was registered is the person's choice, not the file's (#77).
  if (located.status !== 'FOUND') return { kind: 'ALTERED_OPINION_NOT_CHECKABLE', ...resolved, reason: located.status === 'NOT_FOUND' ? located.reason : 'MULTIPLE_OPINION_HEADINGS' };
  const commitment = opinionCommitmentOf({ salt: hexToBytes(claim.opinionSalt as Hex), type: located.type, text: located.text });
  return { kind: commitment === original.opinionCommitment ? 'ALTERED_OPINION_APPEARS_UNCHANGED' : 'ALTERED_OPINION_CHANGED', ...resolved };
}

/** What a reader is shown about a record: its place in the family, when and by whom it was anchored, and whether it stands. */
export async function summariseRecord(view: RegistryView, record: RegistryRecord): Promise<RecordSummary> {
  const block = BigInt(record.blockNumber);
  const [blockTime, txHash, orgId] = await Promise.all([view.blockTime(block), view.anchoringTx(record.recordId, block), view.issuerOrg(record.issuer)]);
  return {
    recordId: record.recordId,
    kind: record.kind,
    familyId: record.familyId,
    version: record.version,
    docHash: record.docHash,
    blockNumber: record.blockNumber,
    blockTime,
    txHash,
    issuer: record.issuer,
    orgId,
    revoked: record.revoked,
    revokeReason: record.revokeReason,
    revokeEffectiveAt: record.revokeEffectiveAt,
  };
}
