import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@/generated/prisma/client';
import { appendAuditEvent } from '@/lib/audit';
import { checkAllAuditChains, checkAuditChain, NO_WITNESS, type AuditHeadWitness } from '@/lib/audit-check';
import type { AnchorTarget } from '@/lib/anchoring/target';

/**
 * The nightly audit-chain check (#57). The log is append-only for the app's
 * own queries (a trigger refuses UPDATE and DELETE); someone who owns the
 * database can turn that off, which is what these tests do to stand in for
 * them, and what the check exists to catch.
 */

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
let orgId: string;

const append = (n: number, action: 'engagement.created' | 'version.uploaded' = 'engagement.created') =>
  prisma.$transaction(async (tx) => {
    for (let i = 0; i < n; i++) await appendAuditEvent(tx, { orgId, actorId: null, action, subjectType: 'Engagement', subjectId: `e${i}`, data: { i } });
  });

/** Runs as the database's owner would, with the append-only trigger off. */
async function asOwner(sql: string) {
  await prisma.$executeRawUnsafe('ALTER TABLE "AuditEvent" DISABLE TRIGGER "AuditEvent_append_only"');
  try {
    await prisma.$executeRawUnsafe(sql);
  } finally {
    await prisma.$executeRawUnsafe('ALTER TABLE "AuditEvent" ENABLE TRIGGER "AuditEvent_append_only"');
  }
}

beforeEach(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE "AuditChainCheck", "AuditEvent", "ChainWrite", "IssuerOrg" CASCADE');
  orgId = (await prisma.issuerOrg.create({ data: { name: 'Example Audit OOD' } })).id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('the nightly audit-chain check', () => {
  it('records an intact chain with its count and head, and an empty one as intact', async () => {
    expect(await checkAuditChain(prisma, orgId, NO_WITNESS)).toMatchObject({ ok: true, count: 0 });
    await append(3);
    const outcome = await checkAuditChain(prisma, orgId, NO_WITNESS);
    const head = (await prisma.auditEvent.findUniqueOrThrow({ where: { orgId_seq: { orgId, seq: 3 } } })).hash;
    expect(outcome).toEqual({ ok: true, count: 3, head, chainHeads: 0, queued: null });
    expect(await prisma.auditChainCheck.findFirst({ where: { orgId }, orderBy: { checkedAt: 'desc' } })).toMatchObject({ ok: true, count: 3, head });
  });

  it('finds an edited event by its hash', async () => {
    await append(3);
    await asOwner(`UPDATE "AuditEvent" SET "data" = '{"i": 99}' WHERE "orgId" = '${orgId}' AND "seq" = 2`);
    expect(await checkAuditChain(prisma, orgId, NO_WITNESS)).toEqual({ ok: false, seq: 2, reason: 'HASH_MISMATCH' });
    expect(await prisma.auditChainCheck.findFirst({ where: { orgId, ok: false } })).toMatchObject({ brokenSeq: 2, reason: 'HASH_MISMATCH' });
  });

  it('finds a tail cut off after an intact check, though what is left verifies', async () => {
    await append(4);
    await checkAuditChain(prisma, orgId, NO_WITNESS, new Date('2026-10-24T02:17:00Z'));
    await asOwner(`DELETE FROM "AuditEvent" WHERE "orgId" = '${orgId}' AND "seq" >= 3`);
    expect(await checkAuditChain(prisma, orgId, NO_WITNESS, new Date('2026-10-25T02:17:00Z'))).toEqual({ ok: false, seq: 3, reason: 'TRUNCATED' });
  });

  it('finds history rewritten and re-hashed after an intact check, and keeps finding it', async () => {
    await append(2);
    await checkAuditChain(prisma, orgId, NO_WITNESS, new Date('2026-10-24T02:17:00Z'));
    // Replace event 2 with another, correctly hashed: the chain alone verifies.
    await asOwner(`DELETE FROM "AuditEvent" WHERE "orgId" = '${orgId}' AND "seq" = 2`);
    await append(1, 'version.uploaded');
    expect(await checkAuditChain(prisma, orgId, NO_WITNESS, new Date('2026-10-25T02:17:00Z'))).toEqual({ ok: false, seq: 2, reason: 'REWRITTEN' });
    // New events do not wash it out: the next check is still held to the last intact one.
    await append(2);
    expect(await checkAuditChain(prisma, orgId, NO_WITNESS, new Date('2026-10-26T02:17:00Z'))).toEqual({ ok: false, seq: 2, reason: 'REWRITTEN' });
  });

  it('lets a chain grow between checks, and checks every firm', async () => {
    const other = (await prisma.issuerOrg.create({ data: { name: 'Another Firm' } })).id;
    await append(2);
    await checkAuditChain(prisma, orgId, NO_WITNESS, new Date('2026-10-24T02:17:00Z'));
    await append(3);
    const results = await checkAllAuditChains(prisma, NO_WITNESS, new Date('2026-10-25T02:17:00Z'));
    expect(results).toHaveLength(2);
    expect(results).toEqual(
      expect.arrayContaining([
        { orgId, outcome: expect.objectContaining({ ok: true, count: 5 }) },
        { orgId: other, outcome: expect.objectContaining({ ok: true, count: 0 }) },
      ]),
    );
  });
});

/**
 * The heads on chain (#94), here a list standing in for the registry; the
 * worker writing them and the registry reading them back are tested on Anvil
 * (tests/anchoring/audit-head.test.ts).
 */
describe('holding the log to its heads on chain', () => {
  const TARGET: AnchorTarget = { network: 'local', chainId: 31337, registry: `0x${'1'.repeat(40)}`, issuer: `0x${'2'.repeat(40)}` };
  let onChain: { index: number; head: string; recordedAt: number }[];
  const witness: AuditHeadWitness = { heads: async () => onChain, target: TARGET };
  const headOf = async (seq: number) => (await prisma.auditEvent.findUniqueOrThrow({ where: { orgId_seq: { orgId, seq } } })).hash;
  const live = () => prisma.issuerOrg.update({ where: { id: orgId }, data: { chainWriteMode: 'LIVE' } });

  beforeEach(() => {
    onChain = [];
  });

  it('finds a rewrite of both the log and its checks, which no check in the database can', async () => {
    await append(3);
    await checkAuditChain(prisma, orgId, witness, new Date('2026-10-24T02:17:00Z'));
    // The head written on chain that night.
    onChain = [{ index: 0, head: await headOf(3), recordedAt: 1_792_800_000 }];
    // The database's owner rewrites event 2, re-hashes everything after it, and
    // rewrites the checks to match, so the database alone holds nothing to compare.
    await asOwner(`DELETE FROM "AuditEvent" WHERE "orgId" = '${orgId}' AND "seq" >= 2`);
    await append(2, 'version.uploaded');
    await prisma.$executeRawUnsafe(`DELETE FROM "AuditChainCheck" WHERE "orgId" = '${orgId}'`);
    expect(await checkAuditChain(prisma, orgId, NO_WITNESS, new Date('2026-10-25T02:00:00Z'))).toMatchObject({ ok: true, count: 3 });
    // The head on chain is still there, and the log no longer holds it.
    expect(await checkAuditChain(prisma, orgId, witness, new Date('2026-10-25T02:17:00Z'))).toEqual({ ok: false, seq: null, reason: 'ANCHORED_HEAD_MISSING', missing: [0] });
    expect(await prisma.auditChainCheck.findFirst({ where: { orgId }, orderBy: { checkedAt: 'desc' } })).toMatchObject({ ok: false, reason: 'ANCHORED_HEAD_MISSING', brokenSeq: null });
  });

  it('holds the log to every head, not only the latest: a head written after a rewrite does not excuse it', async () => {
    await append(2);
    onChain = [{ index: 0, head: await headOf(2), recordedAt: 1_792_800_000 }];
    await asOwner(`DELETE FROM "AuditEvent" WHERE "orgId" = '${orgId}' AND "seq" = 2`);
    await append(2, 'version.uploaded');
    // The owner of the database had the worker write the rewritten log's head too.
    onChain.push({ index: 1, head: await headOf(3), recordedAt: 1_792_886_400 });
    expect(await checkAuditChain(prisma, orgId, witness)).toEqual({ ok: false, seq: null, reason: 'ANCHORED_HEAD_MISSING', missing: [0] });
  });

  it('passes a log that holds every head, and records how many and when the latest was written', async () => {
    await append(2);
    onChain = [{ index: 0, head: await headOf(1), recordedAt: 1_792_800_000 }, { index: 1, head: await headOf(2), recordedAt: 1_792_886_400 }];
    await append(1);
    expect(await checkAuditChain(prisma, orgId, witness)).toMatchObject({ ok: true, count: 3, chainHeads: 2 });
    expect(await prisma.auditChainCheck.findFirst({ where: { orgId }, orderBy: { checkedAt: 'desc' } })).toMatchObject({
      ok: true,
      chainHeads: 2,
      chainHeadAt: new Date(1_792_886_400 * 1000),
    });
  });

  it('fails closed, by name, when the chain cannot be read', async () => {
    await append(1);
    const unreadable: AuditHeadWitness = { heads: async () => Promise.reject(new Error('endpoint down')), target: TARGET };
    expect(await checkAuditChain(prisma, orgId, unreadable)).toEqual({ ok: false, seq: null, reason: 'CHAIN_UNREADABLE' });
    // A database break is still named first.
    await asOwner(`UPDATE "AuditEvent" SET "data" = '{"i": 99}' WHERE "orgId" = '${orgId}' AND "seq" = 1`);
    expect(await checkAuditChain(prisma, orgId, unreadable)).toEqual({ ok: false, seq: 1, reason: 'HASH_MISMATCH' });
  });

  it('queues the head for the chain when the log has moved on, once, and not while writes are disabled', async () => {
    await append(2);
    // DISABLED, the firm's default: nothing is queued.
    expect(await checkAuditChain(prisma, orgId, witness)).toMatchObject({ ok: true, queued: null });
    await live();
    const first = await checkAuditChain(prisma, orgId, witness);
    if (!first.ok || !first.queued) throw new Error('expected a queued head');
    const write = await prisma.chainWrite.findUniqueOrThrow({ where: { id: first.queued } });
    expect(write).toMatchObject({ orgId, kind: 'AUDIT_HEAD', auditHead: first.head, reportVersionId: null, mode: 'LIVE', status: 'INTENT', chainId: 31337, registry: TARGET.registry, issuer: TARGET.issuer });
    const queued = await prisma.auditEvent.findFirstOrThrow({ where: { orgId, action: 'audit_head.queued' } });
    expect(queued).toMatchObject({ subjectId: first.queued, data: { auditHead: first.head, seq: 2 } });
    // While it is in flight, nothing more is queued, whatever else happens.
    await append(1);
    expect(await checkAuditChain(prisma, orgId, witness)).toMatchObject({ ok: true, queued: null });
    expect(await prisma.chainWrite.count({ where: { kind: 'AUDIT_HEAD' } })).toBe(1);
  });

  it('queues nothing when the only events since the last head on chain are about writing heads', async () => {
    await live();
    await append(2);
    const first = await checkAuditChain(prisma, orgId, witness);
    if (!first.ok || !first.queued) throw new Error('expected a queued head');
    // The worker wrote it: the head is on chain, and the journal row is final.
    onChain = [{ index: 0, head: first.head, recordedAt: 1_792_800_000 }];
    await prisma.chainWrite.update({ where: { id: first.queued }, data: { status: 'FINAL' } });
    expect(await checkAuditChain(prisma, orgId, witness)).toMatchObject({ ok: true, chainHeads: 1, queued: null });
    // Anything else moves the log on, and the next head is queued.
    await append(1);
    expect(await checkAuditChain(prisma, orgId, witness)).toMatchObject({ ok: true, queued: expect.any(String) });
  });

  it('refuses a journal row for a head that names a version, or one for a version that carries a head', async () => {
    await expect(
      prisma.chainWrite.create({ data: { orgId, kind: 'AUDIT_HEAD', mode: 'LIVE', chainId: 1, registry: 'r', issuer: 'i' } }),
    ).rejects.toThrow();
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "ChainWrite" ("id","orgId","kind","auditHead","mode","chainId","registry","issuer","updatedAt") VALUES ('x','${orgId}','ANCHOR','0x01','LIVE',1,'r','i',now())`,
      ),
    ).rejects.toThrow(/ChainWrite_audit_head_shape/);
  });
});
