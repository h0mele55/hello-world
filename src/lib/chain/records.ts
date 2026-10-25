import { encodeAbiParameters, keccak256, type Address, type Hex } from 'viem';
import { ChainError } from './errors';

export const ZERO_HASH = `0x${'0'.repeat(64)}` as Hex;

/** In the order of the contract's `Kind` enum. */
export const RECORD_KINDS = ['ORIGINAL', 'DISTRIBUTION_COPY'] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];

export interface RegistryRecord {
  recordId: Hex;
  familyId: Hex;
  docHash: Hex;
  manifestHash: Hex;
  opinionCommitment: Hex;
  /** Previous version for an ORIGINAL (zero for version 1); the original for a copy. */
  parentId: Hex;
  issuer: Address;
  blockNumber: number;
  version: number;
  kind: RecordKind;
  /** In effect at the block read: asked for, and its time has come (#95). */
  revoked: boolean;
  /** Non-zero once a revocation was asked for, pending or in effect. */
  revokeReason: number;
  /** When the revocation takes effect, in Unix seconds; zero when none was asked for. */
  revokeEffectiveAt: number;
}

/** The struct as viem decodes `getRecord`. */
export interface RawRecord {
  familyId: Hex;
  docHash: Hex;
  manifestHash: Hex;
  opinionCommitment: Hex;
  parentId: Hex;
  issuer: Address;
  blockNumber: number;
  version: number;
  kind: number;
  revoked: boolean;
  revokeReason: number;
  revokeEffectiveAt: number;
}

/**
 * Where a record's revocation stands at the block it was read at: none asked
 * for, asked for and waiting out the delay (the owner may still cancel it), or
 * in effect, which is terminal.
 */
export type RevocationState = 'NONE' | 'PENDING' | 'IN_EFFECT';

export function revocationStateOf(record: Pick<RegistryRecord, 'revoked' | 'revokeReason'>): RevocationState {
  if (record.revoked) return 'IN_EFFECT';
  return record.revokeReason !== 0 ? 'PENDING' : 'NONE';
}

/** An all-zero struct is how the contract says "no such record". */
export function decodeRecord(recordId: Hex, raw: RawRecord): RegistryRecord | null {
  if (raw.docHash === ZERO_HASH) return null;
  const kind = RECORD_KINDS[raw.kind];
  if (!kind) throw new ChainError('UNKNOWN_KIND', `Record ${recordId} has unknown kind ${raw.kind}`);
  return {
    recordId,
    familyId: raw.familyId,
    docHash: raw.docHash,
    manifestHash: raw.manifestHash,
    opinionCommitment: raw.opinionCommitment,
    parentId: raw.parentId,
    issuer: raw.issuer,
    blockNumber: raw.blockNumber,
    version: raw.version,
    kind,
    revoked: raw.revoked,
    revokeReason: raw.revokeReason,
    revokeEffectiveAt: raw.revokeEffectiveAt,
  };
}

/** Mirrors `AuditReportRegistry.recordIdFor`: the id is known before the transaction is sent. */
export function recordIdFor(
  chainId: number,
  registry: Address,
  familyId: Hex,
  version: number,
  kind: RecordKind,
): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'address' }, { type: 'bytes32' }, { type: 'uint32' }, { type: 'uint8' }],
      [BigInt(chainId), registry, familyId, version, RECORD_KINDS.indexOf(kind)],
    ),
  );
}
