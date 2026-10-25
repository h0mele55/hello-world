import { hexToBytes } from 'viem';
import type { PrismaClient } from '@/generated/prisma/client';
import { appendAuditEvent } from '@/lib/audit';
import { BITCOIN_EXPLORERS, BitcoinError, bitcoinTimeOf, esploraSource, type BitcoinTime, type HeaderCache, type HeaderSource } from './bitcoin';
import { MIN_CALENDARS, submitDigest, upgradeProof, type CalendarDeps } from './calendar';
import { OtsError, parseProof, serializeProof, type Proof } from './format';

/**
 * The OpenTimestamps job (#66), run by `npm run ots` (scripts/ots.ts). Each
 * pass sends the manifest hash of every version whose anchor is final to the
 * calendars and keeps the proof once two took it; then asks the calendars
 * about each pending proof, and checks any Bitcoin attestation they added
 * against two explorers. COMPLETE only on that check; BROKEN only when the
 * proof leads to something the block does not hold. Anything else (a
 * calendar or an explorer out, the explorers disagreeing) leaves the proof
 * PENDING with a name for why, and the next pass tries again.
 *
 * It holds no key and writes no chain. It sends the calendars a hash of the
 * manifest hash and a nonce, nothing else.
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

export interface OtsReport {
  submitted: string[];
  /** Versions fewer than MIN_CALENDARS calendars took; tried again next pass. */
  notSubmitted: string[];
  complete: string[];
  broken: string[];
  /** Proofs still pending, with why when a pass could not finish them. */
  pending: { versionId: string; reason: string | null }[];
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
  for (const version of fresh) {
    const digest = version.manifestHash!;
    const { proof, accepted } = await submitDigest(hexToBytes(digest as `0x${string}`), deps.calendar);
    if (accepted.length < MIN_CALENDARS) {
      report.notSubmitted.push(version.id);
      continue;
    }
    const at = now();
    try {
      await deps.prisma.$transaction(async (tx) => {
        const row = await tx.otsProof.create({
          // Not asked about until the interval has passed: the calendars have only just taken it.
          data: { reportVersionId: version.id, digest, proof: serializeProof(proof), calendars: accepted, submittedAt: at, checkedAt: at },
          select: { id: true },
        });
        await appendAuditEvent(
          tx,
          { orgId: version.engagement.client.orgId, actorId: null, action: 'ots.submitted', subjectType: 'ReportVersion', subjectId: version.id, data: { otsProofId: row.id, manifestHash: digest, calendars: accepted.length } },
          at,
        );
      });
      report.submitted.push(version.id);
    } catch (error) {
      // Another pass kept a proof for this version first.
      if ((error as { code?: string }).code !== 'P2002') throw error;
    }
  }

  // ── Upgrade and check ──
  const due = await deps.prisma.otsProof.findMany({
    where: { status: 'PENDING', OR: [{ checkedAt: null }, { checkedAt: { lt: new Date(now().getTime() - upgradeEveryMs) } }] },
    select: { id: true, reportVersionId: true, proof: true, checkedAt: true, reportVersion: { select: { engagement: { select: { client: { select: { orgId: true } } } } } } },
    orderBy: { checkedAt: { sort: 'asc', nulls: 'first' } },
    take: batch,
  });
  const cache: HeaderCache = new Map();
  for (const row of due) {
    const orgId = row.reportVersion.engagement.client.orgId;
    const at = now();
    // Conditional on the row being as it was read: two passes never both finish it.
    const unchanged = { id: row.id, status: 'PENDING' as const, checkedAt: row.checkedAt };
    let proof: Proof;
    try {
      proof = parseProof(new Uint8Array(row.proof));
    } catch (error) {
      if (!(error instanceof OtsError)) throw error;
      if (await markBroken(deps.prisma, unchanged, orgId, row.reportVersionId, `PROOF_${error.code}`, at)) report.broken.push(row.reportVersionId);
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
        if (await markBroken(deps.prisma, unchanged, orgId, row.reportVersionId, 'NOT_IN_BLOCK', at, bytes)) report.broken.push(row.reportVersionId);
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
            { orgId, actorId: null, action: 'ots.complete', subjectType: 'ReportVersion', subjectId: row.reportVersionId, data: { otsProofId: row.id, bitcoinHeight: reached.height, bitcoinBlockHash: reached.blockHash } },
            at,
          );
        }
        return done.count === 1;
      });
      if (finished) report.complete.push(row.reportVersionId);
      continue;
    }

    if (!reason && upgrade.failed.length && !upgrade.pending.length && !upgrade.changed) reason = 'CALENDARS_UNREACHABLE';
    await deps.prisma.otsProof.updateMany({ where: unchanged, data: { proof: bytes, checkedAt: at, lastError: reason } });
    report.pending.push({ versionId: row.reportVersionId, reason });
  }
  return report;
}

async function markBroken(
  prisma: PrismaClient,
  unchanged: { id: string; status: 'PENDING'; checkedAt: Date | null },
  orgId: string,
  versionId: string,
  reason: string,
  at: Date,
  proof?: Uint8Array<ArrayBuffer>,
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const done = await tx.otsProof.updateMany({ where: unchanged, data: { status: 'BROKEN', lastError: reason, checkedAt: at, ...(proof ? { proof } : {}) } });
    if (done.count === 1) {
      await appendAuditEvent(tx, { orgId, actorId: null, action: 'ots.broken', subjectType: 'ReportVersion', subjectId: versionId, data: { otsProofId: unchanged.id, reason } }, at);
    }
    return done.count === 1;
  });
}
