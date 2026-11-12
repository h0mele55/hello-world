import { Prisma, type PrismaClient } from '@/generated/prisma/client';
import type { AnchorTarget } from '@/lib/anchoring/target';
import { appendAuditEvent, verifyAuditChain } from '@/lib/audit';
import { orgIdFor } from '@/lib/chain/deploy';

/**
 * The nightly audit-chain check (Phase 5 hardening, #57; #94). Re-deriving
 * every hash catches an edited, removed or reordered event; it cannot catch
 * someone who cut the tail off, or rewrote history and re-hashed everything
 * after it, because the chain they leave verifies. So each check is also held
 * to the last intact one: the chain may only have grown, and the event that
 * was its head must still be there with the same hash.
 *
 * The last intact check lives in the same database, so whoever owns the
 * database can rewrite it too. Hence the heads on chain (#94): each night the
 * check queues the firm's latest audit event's hash for the registry, through
 * the journal, and every head on chain the owner has not voided must still be
 * the hash of one of the firm's events. A head is never removed from the
 * chain, so a rewrite of anything written before the last head is found
 * however the database was edited. A break, once found, stays found.
 *
 * Runs outside the app (scripts/check-audit-chain.ts), so it takes a client.
 */

export type ChainCheckReason =
  | 'SEQ_GAP'
  | 'PREV_HASH_MISMATCH'
  | 'HASH_MISMATCH'
  | 'TRUNCATED'
  | 'REWRITTEN'
  | 'ANCHORED_HEAD_MISSING'
  | 'CHAIN_UNREADABLE'
  /** The key that writes the heads is registered to another firm than this one (#141): its heads are not this log's. */
  | 'FIRM_MISMATCH';

export type ChainCheckOutcome =
  | {
      ok: true;
      count: number;
      head: string;
      /** The heads on chain the log was held to. */
      chainHeads: number;
      /** The journal row queued to write this head, if one was. */
      queued: string | null;
    }
  /**
   * `seq` is null when no event of the log is to blame: a head on chain it
   * lacks, or a chain that could not be read. `missing` names the heads the
   * log lacks, by their index on chain, for the owner to look into.
   */
  | { ok: false; seq: number | null; reason: ChainCheckReason; missing?: number[] };

/** Where the heads are read and written. */
export interface AuditHeadWitness {
  /**
   * The firm's heads on chain that the owner has not voided, as both
   * endpoints read them at one finalized block (#92). Throws when the chain
   * cannot be read or the endpoints disagree.
   */
  heads(org: { id: string; name: string }): Promise<{ index: number; head: string; recordedAt: number }[]>;
  /** Where a new head is written; null queues nothing. */
  target: AnchorTarget | null;
  /**
   * The org id on chain of the key that writes the heads (#141), read on both
   * endpoints. When given, only the database firm of that name is held to the
   * heads and has heads queued. Throws when the chain cannot be read.
   */
  firm?(): Promise<string>;
}

/** The nightly check cannot tell which firm the key belongs to (#141). */
export class AuditCheckRefused extends Error {
  constructor(readonly code: 'FIRM_AMBIGUOUS', detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'AuditCheckRefused';
  }
}

/** For a chain with no heads and nothing to queue: a firm before #94, and the database-only tests. */
export const NO_WITNESS: AuditHeadWitness = { heads: async () => [], target: null };

/** Events that record writing a head; they alone are no reason to write another. */
export const AUDIT_HEAD_ACTION_PREFIX = 'audit_head.';

export async function checkAuditChain(prisma: PrismaClient, orgId: string, witness: AuditHeadWitness, now = new Date()): Promise<ChainCheckOutcome> {
  const org = await prisma.issuerOrg.findUniqueOrThrow({ where: { id: orgId }, select: { id: true, name: true, chainWriteMode: true } });
  const verified = await verifyAuditChain(prisma, orgId);
  let outcome: ChainCheckOutcome = verified.ok ? { ...verified, chainHeads: 0, queued: null } : verified;
  let chainHeadAt: Date | null = null;
  let anchoredSeq = 0;
  if (outcome.ok) {
    const last = await prisma.auditChainCheck.findFirst({ where: { orgId, ok: true }, orderBy: { checkedAt: 'desc' }, select: { count: true, head: true } });
    if (last && last.count > 0) {
      if (outcome.count < last.count) {
        outcome = { ok: false, seq: outcome.count + 1, reason: 'TRUNCATED' };
      } else {
        const then = await prisma.auditEvent.findUnique({ where: { orgId_seq: { orgId, seq: last.count } }, select: { hash: true } });
        if (then?.hash !== last.head) outcome = { ok: false, seq: last.count, reason: 'REWRITTEN' };
      }
    }
  }
  if (outcome.ok) {
    let heads: { index: number; head: string; recordedAt: number }[] | null = null;
    try {
      // Held only to heads written by a key registered to this very firm (#141).
      if (witness.firm && orgIdFor(org.name).toLowerCase() !== (await witness.firm()).toLowerCase()) {
        outcome = { ok: false, seq: null, reason: 'FIRM_MISMATCH' };
      } else {
        heads = await witness.heads(org);
      }
    } catch {
      outcome = { ok: false, seq: null, reason: 'CHAIN_UNREADABLE' };
    }
    if (heads && outcome.ok) {
      const wanted = [...new Set(heads.map((h) => h.head.toLowerCase()))];
      const found = await prisma.auditEvent.findMany({ where: { orgId, hash: { in: wanted } }, select: { hash: true, seq: true } });
      const held = new Set(found.map((e) => e.hash.toLowerCase()));
      const missing = heads.filter((h) => !held.has(h.head.toLowerCase())).map((h) => h.index);
      if (missing.length) {
        outcome = { ok: false, seq: null, reason: 'ANCHORED_HEAD_MISSING', missing };
      } else {
        outcome = { ...outcome, chainHeads: heads.length };
        anchoredSeq = Math.max(0, ...found.map((e) => e.seq));
        if (heads.length) chainHeadAt = new Date(Math.max(...heads.map((h) => h.recordedAt)) * 1000);
      }
    }
  }
  await prisma.auditChainCheck.create({
    data: outcome.ok
      ? { orgId, checkedAt: now, ok: true, count: outcome.count, head: outcome.head, chainHeads: outcome.chainHeads, chainHeadAt }
      : { orgId, checkedAt: now, ok: false, count: 0, brokenSeq: outcome.seq, reason: outcome.reason },
  });
  if (outcome.ok && outcome.count > 0) outcome = { ...outcome, queued: await queueHead(prisma, org, outcome, anchoredSeq, witness.target, now) };
  return outcome;
}

/**
 * Queues the head for the chain when the log has moved on since the last
 * head written there, by anything but the writing of heads; else a firm with
 * no activity would write a head every night for ever. Nothing while writes
 * are DISABLED, and nothing while the last head is still in flight (an index
 * holds it).
 */
async function queueHead(
  prisma: PrismaClient,
  org: { id: string; chainWriteMode: 'DISABLED' | 'DRY_RUN' | 'LIVE' },
  checked: { count: number; head: string },
  anchoredSeq: number,
  target: AnchorTarget | null,
  now: Date,
): Promise<string | null> {
  if (!target || org.chainWriteMode === 'DISABLED') return null;
  const news = await prisma.auditEvent.count({
    where: { orgId: org.id, seq: { gt: anchoredSeq, lte: checked.count }, NOT: { action: { startsWith: AUDIT_HEAD_ACTION_PREFIX } } },
  });
  if (news === 0) return null;
  try {
    return await prisma.$transaction(async (tx) => {
      const write = await tx.chainWrite.create({
        data: { orgId: org.id, kind: 'AUDIT_HEAD', auditHead: checked.head, mode: org.chainWriteMode, chainId: target.chainId, registry: target.registry, issuer: target.issuer },
        select: { id: true },
      });
      await appendAuditEvent(
        tx,
        { orgId: org.id, actorId: null, action: 'audit_head.queued', subjectType: 'ChainWrite', subjectId: write.id, data: { auditHead: checked.head, seq: checked.count } },
        now,
      );
      return write.id;
    });
  } catch (error) {
    // The last head is still in flight: the next night's check queues this one.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return null;
    throw error;
  }
}

/**
 * Checks every firm's chain; the caller alerts on any that is not intact.
 * With a witness that names its key's firm (#141), that firm alone is held to
 * the heads on chain and has heads queued; any other firm in the database is
 * checked on the database alone (`chainBound: false`), since the key writes
 * none of its heads. When no firm is the key's, each fails FIRM_MISMATCH;
 * when two are, nothing can be told apart, and the check is refused.
 */
export async function checkAllAuditChains(prisma: PrismaClient, witness: AuditHeadWitness, now = new Date()) {
  const orgs = await prisma.issuerOrg.findMany({ select: { id: true, name: true }, orderBy: { createdAt: 'asc' } });
  let bound: Set<string> | null = null;
  if (witness.firm) {
    let keyOrg: string | null = null;
    try {
      keyOrg = (await witness.firm()).toLowerCase();
    } catch {
      // Unreadable: each firm's check records CHAIN_UNREADABLE.
    }
    if (keyOrg !== null) {
      const ofKey = orgs.filter((org) => orgIdFor(org.name).toLowerCase() === keyOrg);
      if (ofKey.length > 1) throw new AuditCheckRefused('FIRM_AMBIGUOUS', `${ofKey.length} firms in the database have the name the key is registered under`);
      if (ofKey.length === 1) bound = new Set(ofKey.map((org) => org.id));
    }
  }
  const results: { orgId: string; outcome: ChainCheckOutcome; chainBound: boolean }[] = [];
  for (const org of orgs) {
    const chainBound = bound === null || bound.has(org.id);
    results.push({ orgId: org.id, outcome: await checkAuditChain(prisma, org.id, chainBound ? witness : NO_WITNESS, now), chainBound: chainBound && witness !== NO_WITNESS });
  }
  return results;
}
