import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@/generated/prisma/client';
import { appendAuditEvent } from '@/lib/audit';
import { checkAllAuditChains, checkAuditChain } from '@/lib/audit-check';

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
  await prisma.$executeRawUnsafe('TRUNCATE "AuditChainCheck", "AuditEvent", "IssuerOrg" CASCADE');
  orgId = (await prisma.issuerOrg.create({ data: { name: 'Example Audit OOD' } })).id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('the nightly audit-chain check', () => {
  it('records an intact chain with its count and head, and an empty one as intact', async () => {
    expect(await checkAuditChain(prisma, orgId)).toMatchObject({ ok: true, count: 0 });
    await append(3);
    const outcome = await checkAuditChain(prisma, orgId);
    const head = (await prisma.auditEvent.findUniqueOrThrow({ where: { orgId_seq: { orgId, seq: 3 } } })).hash;
    expect(outcome).toEqual({ ok: true, count: 3, head });
    expect(await prisma.auditChainCheck.findFirst({ where: { orgId }, orderBy: { checkedAt: 'desc' } })).toMatchObject({ ok: true, count: 3, head });
  });

  it('finds an edited event by its hash', async () => {
    await append(3);
    await asOwner(`UPDATE "AuditEvent" SET "data" = '{"i": 99}' WHERE "orgId" = '${orgId}' AND "seq" = 2`);
    expect(await checkAuditChain(prisma, orgId)).toEqual({ ok: false, seq: 2, reason: 'HASH_MISMATCH' });
    expect(await prisma.auditChainCheck.findFirst({ where: { orgId, ok: false } })).toMatchObject({ brokenSeq: 2, reason: 'HASH_MISMATCH' });
  });

  it('finds a tail cut off after an intact check, though what is left verifies', async () => {
    await append(4);
    await checkAuditChain(prisma, orgId, new Date('2026-10-24T02:17:00Z'));
    await asOwner(`DELETE FROM "AuditEvent" WHERE "orgId" = '${orgId}' AND "seq" >= 3`);
    expect(await checkAuditChain(prisma, orgId, new Date('2026-10-25T02:17:00Z'))).toEqual({ ok: false, seq: 3, reason: 'TRUNCATED' });
  });

  it('finds history rewritten and re-hashed after an intact check, and keeps finding it', async () => {
    await append(2);
    await checkAuditChain(prisma, orgId, new Date('2026-10-24T02:17:00Z'));
    // Replace event 2 with another, correctly hashed: the chain alone verifies.
    await asOwner(`DELETE FROM "AuditEvent" WHERE "orgId" = '${orgId}' AND "seq" = 2`);
    await append(1, 'version.uploaded');
    expect(await checkAuditChain(prisma, orgId, new Date('2026-10-25T02:17:00Z'))).toEqual({ ok: false, seq: 2, reason: 'REWRITTEN' });
    // New events do not wash it out: the next check is still held to the last intact one.
    await append(2);
    expect(await checkAuditChain(prisma, orgId, new Date('2026-10-26T02:17:00Z'))).toEqual({ ok: false, seq: 2, reason: 'REWRITTEN' });
  });

  it('lets a chain grow between checks, and checks every firm', async () => {
    const other = (await prisma.issuerOrg.create({ data: { name: 'Another Firm' } })).id;
    await append(2);
    await checkAuditChain(prisma, orgId, new Date('2026-10-24T02:17:00Z'));
    await append(3);
    const results = await checkAllAuditChains(prisma, new Date('2026-10-25T02:17:00Z'));
    expect(results).toHaveLength(2);
    expect(results).toEqual(
      expect.arrayContaining([
        { orgId, outcome: expect.objectContaining({ ok: true, count: 5 }) },
        { orgId: other, outcome: expect.objectContaining({ ok: true, count: 0 }) },
      ]),
    );
  });
});
