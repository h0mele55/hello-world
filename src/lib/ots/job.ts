import { hexToBytes, type Hex } from 'viem';
import type { PrismaClient } from '@/generated/prisma/client';
import { appendAuditEvent } from '@/lib/audit';
import { BITCOIN_EXPLORERS, BitcoinError, bitcoinTimeOf, esploraSource, type BitcoinTime, type HeaderCache, type HeaderSource } from './bitcoin';
import { MIN_CALENDARS, submitDigest, upgradeProof, type CalendarDeps } from './calendar';
import { OtsError, parseProof, serializeProof, type Proof } from './format';
import { checkpointDigest } from '../verify-core/reanchor';

/**
 * The OpenTimestamps job (#66), run by `npm run ots` (scripts/ots.ts). Each
 * pass sends the manifest hash of every version whose anchor is final, and
 * the SHA-256 of every monthly checkpoint's head (#122), to the calendars and
 * keeps the proof once two took it; then asks the calendars
 * about each pending proof, and checks any Bitcoin attestation they added
 * against two explorers. COMPLETE only on that check; BROKEN only when the
 * proof leads to something the block does not hold. Anything else (a
 * calendar or an explorer out, the explorers disagreeing) leaves the proof
 * PENDING with a name for why, and the next pass tries again.
 *
 * It holds no key and writes no chain. It sends the calendars a hash of the
 * digest and a nonce, nothing else.
 */

/** A version's manifest is final on chain from ANCHORED on; a revoked one existed all the same. */
const TIMESTAMPED = ['ANCHORED', 'COMPLETE', 'REVOKED'] as const;

export interface OtsJobDeps {
  prisma: PrismaClient;
  calendar?: CalendarDeps;
  /** The Bitcoin check of a proof; by default, against the two explorers. */
  bitcoinTime?: (proof: Proof, cache: HeaderCache) => Promise<BitcoinTime | null>;
  now?: () => Date;
  /** How long a pending proof waits between asks; Bitcoin confirms a calendar's batch in hours. */
  upgradeEveryMs?: number;
  /** At most this many submissions, and this many upgrades, per pass. */
  batch?: number;
}

/** Ids of versions and of checkpoints, by what became of their proof. */
export interface OtsReport {
  submitted: string[];
  /** Fewer than MIN_CALENDARS calendars took them; tried again next pass. */
  notSubmitted: string[];
  complete: string[];
  broken: string[];
  /** Proofs still pending, with why when a pass could not finish them. */
  pending: { versionId: string; reason: string | null }[];
}

/** What a proof is of: a version's manifest, or a checkpoint's head. */
interface Subject {
  type: 'ReportVersion' | 'RegistryCheckpoint';
  id: string;
  orgId: string;
}

export function defaultBitcoinTime(sources: readonly [HeaderSource, HeaderSource] = [esploraSource(BITCOIN_EXPLORERS[0]), esploraSource(BITCOIN_EXPLORERS[1])]) {
  return (proof: Proof, cache: HeaderCache) => bitcoinTimeOf(proof, sources, cache);
}

export async function runOtsPass(deps: OtsJobDeps): Promise<OtsReport> {
  const now = deps.now ?? (() => new Date());
  const batch = deps.batch ?? 20;
  const upgradeEveryMs = deps.upgradeEveryMs ?? 30 * 60 * 1000;
  const bitcoinTime = deps.bitcoinTime ?? defaultBitcoinTime();
  const report: OtsReport = { submitted: [], notSubmitted: [], complete: [], broken: [], pending: [] };

  // ── Submit ──
  const fresh = await deps.prisma.reportVersion.findMany({
    where: { status: { in: [...TIMESTAMPED] }, manifestHash: { not: null }, otsProof: null },
    select: { id: true, manifestHash: true, engagement: { select: { client: { select: { orgId: true } } } } },
    orderBy: { createdAt: 'asc' },
    take: batch,
  });
  const submit = async (subject: Subject, digest: Hex, about: Record<string, string>) => {
    const { proof, accepted } = await submitDigest(hexToBytes(digest), deps.calendar);
    if (accepted.length < MIN_CALENDARS) {
      report.notSubmitted.push(subject.id);
      return;
    }
    const at = now();
    try {
      await deps.prisma.$transaction(async (tx) => {
        const row = await tx.otsProof.create({
          // Not asked about until the interval has passed: the calendars have only just taken it.
          data: {
            ...(subject.type === 'ReportVersion' ? { reportVersionId: subject.id } : { checkpointId: subject.id }),
            digest,
            proof: serializeProof(proof),
            calendars: accepted,
            submittedAt: at,
            checkedAt: at,
          },
          select: { id: true },
        });
        await appendAuditEvent(
          tx,
          { orgId: subject.orgId, actorId: null, action: 'ots.submitted', subjectType: subject.type, subjectId: subject.id, data: { otsProofId: row.id, ...about, calendars: accepted.length } },
          at,
        );
      });
      report.submitted.push(subject.id);
    } catch (error) {
      // Another pass kept a proof for it first.
      if ((error as { code?: string }).code !== 'P2002') throw error;
    }
  };
  for (const version of fresh) {
    const digest = version.manifestHash as Hex;
    await submit({ type: 'ReportVersion', id: version.id, orgId: version.engagement.client.orgId }, digest, { manifestHash: digest });
  }
  // Each month's checkpoint (#122): the digest is the SHA-256 of its head.
  const checkpoints = await deps.prisma.registryCheckpoint.findMany({
    where: { otsProof: null },
    select: { id: true, orgId: true, chainId: true, registry: true, block: true, period: true, count: true, root: true },
    orderBy: { createdAt: 'asc' },
    take: batch,
  });
  for (const c of checkpoints) {
    const digest = checkpointDigest({ source: { chainId: c.chainId, registry: c.registry as Hex, block: c.block }, period: c.period, count: c.count, root: c.root as Hex });
    await submit({ type: 'RegistryCheckpoint', id: c.id, orgId: c.orgId }, digest, { root: c.root, period: c.period });
  }

  // ── Upgrade and check ──
  const due = await deps.prisma.otsProof.findMany({
    where: { status: 'PENDING', OR: [{ checkedAt: null }, { checkedAt: { lt: new Date(now().getTime() - upgradeEveryMs) } }] },
    select: {
      id: true,
      reportVersionId: true,
      checkpointId: true,
      proof: true,
      checkedAt: true,
      reportVersion: { select: { engagement: { select: { client: { select: { orgId: true } } } } } },
      checkpoint: { select: { orgId: true } },
    },
    orderBy: { checkedAt: { sort: 'asc', nulls: 'first' } },
    take: batch,
  });
  const cache: HeaderCache = new Map();
  for (const row of due) {
    // Exactly one of the two (a CHECK).
    const subject: Subject = row.reportVersion
      ? { type: 'ReportVersion', id: row.reportVersionId!, orgId: row.reportVersion.engagement.client.orgId }
      : { type: 'RegistryCheckpoint', id: row.checkpointId!, orgId: row.checkpoint!.orgId };
    const at = now();
    // Conditional on the row being as it was read: two passes never both finish it.
    const unchanged = { id: row.id, status: 'PENDING' as const, checkedAt: row.checkedAt };
    let proof: Proof;
    try {
      proof = parseProof(new Uint8Array(row.proof));
    } catch (error) {
      if (!(error instanceof OtsError)) throw error;
      if (await markBroken(deps.prisma, unchanged, subject, `PROOF_${error.code}`, at)) report.broken.push(subject.id);
      continue;
    }

    const upgrade = await upgradeProof(proof, deps.calendar);
    const bytes = serializeProof(proof);
    let reached: BitcoinTime | null = null;
    let reason: string | null = null;
    try {
      reached = await bitcoinTime(proof, cache);
    } catch (error) {
      if (!(error instanceof BitcoinError)) throw error;
      if (error.code === 'NOT_IN_BLOCK') {
        if (await markBroken(deps.prisma, unchanged, subject, 'NOT_IN_BLOCK', at, bytes)) report.broken.push(subject.id);
        continue;
      }
      reason = `BITCOIN_${error.code}`;
    }

    if (reached) {
      const finished = await deps.prisma.$transaction(async (tx) => {
        const done = await tx.otsProof.updateMany({
          where: unchanged,
          data: {
            status: 'COMPLETE',
            proof: bytes,
            checkedAt: at,
            lastError: null,
            bitcoinHeight: reached.height,
            bitcoinBlockHash: reached.blockHash,
            bitcoinTime: new Date(reached.time * 1000),
            completedAt: at,
          },
        });
        if (done.count === 1) {
          await appendAuditEvent(
            tx,
            { orgId: subject.orgId, actorId: null, action: 'ots.complete', subjectType: subject.type, subjectId: subject.id, data: { otsProofId: row.id, bitcoinHeight: reached.height, bitcoinBlockHash: reached.blockHash } },
            at,
          );
        }
        return done.count === 1;
      });
      if (finished) report.complete.push(subject.id);
      continue;
    }

    if (!reason && upgrade.failed.length && !upgrade.pending.length && !upgrade.changed) reason = 'CALENDARS_UNREACHABLE';
    await deps.prisma.otsProof.updateMany({ where: unchanged, data: { proof: bytes, checkedAt: at, lastError: reason } });
    report.pending.push({ versionId: subject.id, reason });
  }
  return report;
}

async function markBroken(
  prisma: PrismaClient,
  unchanged: { id: string; status: 'PENDING'; checkedAt: Date | null },
  subject: Subject,
  reason: string,
  at: Date,
  proof?: Uint8Array<ArrayBuffer>,
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const done = await tx.otsProof.updateMany({ where: unchanged, data: { status: 'BROKEN', lastError: reason, checkedAt: at, ...(proof ? { proof } : {}) } });
    if (done.count === 1) {
      await appendAuditEvent(tx, { orgId: subject.orgId, actorId: null, action: 'ots.broken', subjectType: subject.type, subjectId: subject.id, data: { otsProofId: unchanged.id, reason } }, at);
    }
    return done.count === 1;
  });
}
