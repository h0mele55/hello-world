import { getAddress, type Address, type Hash, type Hex, type PublicClient } from 'viem';
import type { PrismaClient } from '@/generated/prisma/client';
import type { VersionStatus } from '@/generated/prisma/enums';
import { agreedFinalizedBlock, readOnBoth } from '@/lib/chain/agree';
import type { Deployment } from '@/lib/chain/deployment';
import { createRegistryReader } from '@/lib/chain/reader';
import type { RegistryRecord } from '@/lib/chain/records';
import { registryAbi } from '@/lib/chain/registry-artifact';

/**
 * The firm's database held to the chain (#111): every version's state
 * re-derived from what the registry holds at one finalized block that two
 * endpoints agree on (rule 2, #92). Run after a restore, it names what the
 * backup does not know (anchors, copies and revocations made since) and any
 * record the firm's keys wrote that no version accounts for; run any time, it
 * names a database that disagrees with the chain.
 *
 * It only reads: it writes nothing, to the chain or to the database. What it
 * finds is for a person (docs/runbooks/restore.md); the worker settles what
 * it can on its own next pass.
 */

export type Difference =
  /** The database calls the version anchored; the chain holds no record for its file. */
  | { code: 'RECORD_MISSING'; versionId: string; docHash: Hex }
  /** The chain's record for the file is not the one the database recorded. */
  | { code: 'RECORD_DIFFERS'; versionId: string; recordId: Hex; fields: string[] }
  /** The chain holds the file, and the database does not call it anchored: anchored after the backup. */
  | { code: 'ANCHORED_AFTER_BACKUP'; versionId: string; recordId: Hex }
  /** The database holds the copy's record; the chain does not. */
  | { code: 'COPY_MISSING'; versionId: string; copyDocHash: Hex }
  | { code: 'COPY_DIFFERS'; versionId: string; recordId: Hex; fields: string[] }
  /** The chain holds the copy, and the database has no record of it: anchored after the backup. */
  | { code: 'COPY_ANCHORED_AFTER_BACKUP'; versionId: string; recordId: Hex }
  /** The database calls the version REVOKED; on chain it is not. */
  | { code: 'REVOKED_NOT_ON_CHAIN'; versionId: string }
  /** On chain the revocation is in effect; the database does not call the version REVOKED. */
  | { code: 'REVOKED_ON_CHAIN'; versionId: string; reasonCode: number; effectiveAt: number }
  /** On chain a revocation waits out the registry's delay; the database holds none scheduled. */
  | { code: 'REVOCATION_PENDING_ON_CHAIN'; versionId: string; reasonCode: number; effectiveAt: number }
  /** The database holds a scheduled revocation the chain no longer has: the owner cancelled it. */
  | { code: 'SCHEDULED_NOT_ON_CHAIN'; versionId: string; revocationId: string }
  /** A record written by one of the firm's issuer keys that no version accounts for: lost with the database. */
  | { code: 'UNKNOWN_RECORD'; recordId: Hex; kind: 'ORIGINAL' | 'DISTRIBUTION_COPY'; docHash: Hex; txHash: Hash; blockNumber: number; issuer: Address };

export interface ReconcileDeps {
  prisma: PrismaClient;
  /** Two endpoints from different providers; one client twice on a local chain. */
  clients: readonly [PublicClient, PublicClient];
  deployment: Deployment;
  firm: { orgId: string; onChainOrgId: Hex };
  /** Where the scan for unknown records starts: the registry's deploy block. */
  fromBlock?: bigint;
  rangeBlocks?: number;
}

export interface ReconcileReport {
  /** The finalized block everything was read at. */
  block: bigint;
  versions: number;
  /** Records by the firm's keys found on chain. */
  records: number;
  differences: Difference[];
}

const ANCHORED: VersionStatus[] = ['ANCHORED', 'COMPLETE', 'REVOKED'];
const RANGE_BLOCKS = 2_000;
const lower = (value: string | null | undefined) => value?.toLowerCase() ?? null;

export async function reconcileWithChain(deps: ReconcileDeps): Promise<ReconcileReport> {
  const { prisma, clients, deployment, firm } = deps;
  const readers = [createRegistryReader(clients[0], deployment), createRegistryReader(clients[1], deployment)] as const;
  const readerOf = (client: PublicClient) => (client === clients[0] ? readers[0] : readers[1]);
  // The wrong chain or contract is a refusal, never "nothing differs" (rule 7).
  await Promise.all(readers.map((r) => r.assertDeployment()));
  const block = await agreedFinalizedBlock(clients);
  const at = { blockNumber: block };
  const recordOf = (docHash: string, what: string) => readOnBoth(clients, what, (c) => readerOf(c).findByDocHash(docHash as Hex, at));

  const versions = await prisma.reportVersion.findMany({
    where: { engagement: { client: { orgId: firm.orgId } } },
    select: {
      id: true,
      status: true,
      version: true,
      docHash: true,
      manifestHash: true,
      opinionCommitment: true,
      recordId: true,
      copyDocHash: true,
      copyRecordId: true,
      engagement: { select: { familyId: true } },
      revocations: { where: { status: 'SCHEDULED' }, select: { id: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  const differences: Difference[] = [];
  const known = new Set<string>();
  for (const v of versions) {
    known.add(v.docHash.toLowerCase());
    if (v.copyDocHash) known.add(v.copyDocHash.toLowerCase());
    const original = await recordOf(v.docHash, `the record of version ${v.id}`);
    const anchored = ANCHORED.includes(v.status);

    if (anchored && !original) differences.push({ code: 'RECORD_MISSING', versionId: v.id, docHash: v.docHash as Hex });
    if (!anchored && original) differences.push({ code: 'ANCHORED_AFTER_BACKUP', versionId: v.id, recordId: original.recordId });
    if (anchored && original) {
      const fields = differing(original, {
        recordId: v.recordId,
        kind: 'ORIGINAL',
        familyId: v.engagement.familyId,
        version: v.version,
        manifestHash: v.manifestHash,
        opinionCommitment: v.opinionCommitment,
      });
      if (fields.length) differences.push({ code: 'RECORD_DIFFERS', versionId: v.id, recordId: original.recordId, fields });
    }

    if (original) {
      const pending = original.revokeReason !== 0 && !original.revoked;
      if (v.status === 'REVOKED' && !original.revoked) differences.push({ code: 'REVOKED_NOT_ON_CHAIN', versionId: v.id });
      if (v.status !== 'REVOKED' && original.revoked) {
        differences.push({ code: 'REVOKED_ON_CHAIN', versionId: v.id, reasonCode: original.revokeReason, effectiveAt: original.revokeEffectiveAt });
      }
      if (pending && v.revocations.length === 0) {
        differences.push({ code: 'REVOCATION_PENDING_ON_CHAIN', versionId: v.id, reasonCode: original.revokeReason, effectiveAt: original.revokeEffectiveAt });
      }
      if (!pending && !original.revoked) for (const r of v.revocations) differences.push({ code: 'SCHEDULED_NOT_ON_CHAIN', versionId: v.id, revocationId: r.id });
    } else if (v.status === 'REVOKED') {
      differences.push({ code: 'REVOKED_NOT_ON_CHAIN', versionId: v.id });
    }

    if (v.copyDocHash) {
      const copy = await recordOf(v.copyDocHash, `the copy of version ${v.id}`);
      if (v.copyRecordId && !copy) differences.push({ code: 'COPY_MISSING', versionId: v.id, copyDocHash: v.copyDocHash as Hex });
      if (!v.copyRecordId && copy) differences.push({ code: 'COPY_ANCHORED_AFTER_BACKUP', versionId: v.id, recordId: copy.recordId });
      if (v.copyRecordId && copy) {
        const fields = differing(copy, { recordId: v.copyRecordId, kind: 'DISTRIBUTION_COPY', familyId: v.engagement.familyId, version: v.version, parentId: v.recordId });
        if (fields.length) differences.push({ code: 'COPY_DIFFERS', versionId: v.id, recordId: copy.recordId, fields });
      }
    }
  }

  // Every record the firm's keys wrote, up to the same block: one no version knows was lost with the database.
  const registry = getAddress(deployment.address);
  const firmOf = new Map<Address, boolean>();
  const isFirms = async (issuer: Address) => {
    const cached = firmOf.get(issuer);
    if (cached !== undefined) return cached;
    const [orgId] = await readOnBoth(clients, `the firm of key ${issuer}`, (c) => c.readContract({ address: registry, abi: registryAbi, functionName: 'issuers', args: [issuer], blockNumber: block }));
    const firms = orgId.toLowerCase() === firm.onChainOrgId.toLowerCase();
    firmOf.set(issuer, firms);
    return firms;
  };
  const range = BigInt(deps.rangeBlocks ?? RANGE_BLOCKS);
  let records = 0;
  for (let from = deps.fromBlock ?? 0n; from <= block; from += range) {
    const to = from + range - 1n < block ? from + range - 1n : block;
    const events = await readOnBoth(clients, `the registry's anchors in blocks ${from} to ${to}`, async (c) =>
      (await c.getContractEvents({ address: registry, abi: registryAbi, eventName: 'Anchored', fromBlock: from, toBlock: to })).map((e) => ({
        recordId: e.args.recordId!,
        docHash: e.args.docHash!,
        kind: e.args.kind === 0 ? ('ORIGINAL' as const) : ('DISTRIBUTION_COPY' as const),
        issuer: getAddress(e.args.issuer!),
        txHash: e.transactionHash,
        blockNumber: Number(e.blockNumber),
      })),
    );
    for (const e of events) {
      if (!(await isFirms(e.issuer))) continue;
      records += 1;
      if (!known.has(e.docHash.toLowerCase())) differences.push({ code: 'UNKNOWN_RECORD', ...e });
    }
  }

  return { block, versions: versions.length, records, differences };
}

/** The names of the fields in which the chain's record is not what the database expects. */
function differing(record: RegistryRecord, expected: { recordId: string | null; kind: RegistryRecord['kind']; familyId: string; version: number; manifestHash?: string | null; opinionCommitment?: string | null; parentId?: string | null }) {
  const fields: string[] = [];
  if (lower(expected.recordId) !== record.recordId.toLowerCase()) fields.push('recordId');
  if (expected.kind !== record.kind) fields.push('kind');
  if (lower(expected.familyId) !== record.familyId.toLowerCase()) fields.push('familyId');
  if (expected.version !== record.version) fields.push('version');
  if ('manifestHash' in expected && lower(expected.manifestHash) !== record.manifestHash.toLowerCase()) fields.push('manifestHash');
  if ('opinionCommitment' in expected && lower(expected.opinionCommitment) !== record.opinionCommitment.toLowerCase()) fields.push('opinionCommitment');
  if ('parentId' in expected && lower(expected.parentId) !== record.parentId.toLowerCase()) fields.push('parentId');
  return fields;
}
