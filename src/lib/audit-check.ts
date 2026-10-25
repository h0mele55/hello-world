import type { PrismaClient } from '@/generated/prisma/client';
import { verifyAuditChain } from '@/lib/audit';

/**
 * The nightly audit-chain check (Phase 5 hardening, #57). Re-deriving every
 * hash catches an edited, removed or reordered event; it cannot catch someone
 * who cut the tail off, or rewrote history and re-hashed everything after it,
 * because the chain they leave verifies. So each check is also held to the
 * last intact one: the chain may only have grown, and the event that was its
 * head must still be there with the same hash. A break, once found, stays
 * found: later checks are compared with the last intact one, not with it.
 *
 * Runs outside the app (scripts/check-audit-chain.ts), so it takes a client.
 */

export type ChainCheckReason = 'SEQ_GAP' | 'PREV_HASH_MISMATCH' | 'HASH_MISMATCH' | 'TRUNCATED' | 'REWRITTEN';

export type ChainCheckOutcome = { ok: true; count: number; head: string } | { ok: false; seq: number; reason: ChainCheckReason };

export async function checkAuditChain(prisma: PrismaClient, orgId: string, now = new Date()): Promise<ChainCheckOutcome> {
  let outcome: ChainCheckOutcome = await verifyAuditChain(prisma, orgId);
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
  await prisma.auditChainCheck.create({
    data: outcome.ok
      ? { orgId, checkedAt: now, ok: true, count: outcome.count, head: outcome.head }
      : { orgId, checkedAt: now, ok: false, count: 0, brokenSeq: outcome.seq, reason: outcome.reason },
  });
  return outcome;
}

/** Checks every firm's chain; the caller alerts on any that is not intact. */
export async function checkAllAuditChains(prisma: PrismaClient, now = new Date()) {
  const orgs = await prisma.issuerOrg.findMany({ select: { id: true, name: true }, orderBy: { createdAt: 'asc' } });
  const results: { orgId: string; outcome: ChainCheckOutcome }[] = [];
  for (const org of orgs) results.push({ orgId: org.id, outcome: await checkAuditChain(prisma, org.id, now) });
  return results;
}
