import fs from 'node:fs';
import path from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { SessionUser } from '@/auth';
import { PrismaClient } from '@/generated/prisma/client';
import { verifyAuditChain } from '@/lib/audit';
import { deliverNotifications, type MailMessage, type MailTransport } from '@/lib/notifications/mailer';
import { queueSupersededNotices } from '@/lib/notifications/queue';
import { confirmOpinion, createEngagement, IntakeError, uploadVersion } from '@/lib/reports/intake';
import { addRecipient, listRecipients, MAX_RECIPIENTS, removeRecipient } from '@/lib/reports/recipients';
import { AccessError } from '@/lib/roles';

/**
 * Recipients and the notices they are sent when a newer version supersedes
 * theirs (Phase 5, #56): who may keep the list, one live entry per address,
 * removal cancelling what was not sent, and a mailer that sends at least once,
 * gives up after five tries and never stores what a server said.
 */

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
const fixture = (name: string) => fs.readFileSync(path.join(import.meta.dirname, '..', 'fixtures', 'pdf', name));
const APP_URL = 'https://anchor.example.test/';
const OPINION = 'In our opinion, the financial statements present fairly, in all material respects.';

let preparer: SessionUser;
let approver: SessionUser;
let admin: SessionUser;
let viewer: SessionUser;
let outsider: SessionUser;
let clock: Date;

async function expectIntake(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(IntakeError);
  expect((error as IntakeError).code).toBe(code);
}

beforeEach(async () => {
  clock = new Date('2026-10-25T09:00:00Z');
  fs.rmSync(process.env.FILE_STORAGE_DIR!, { recursive: true, force: true });
  await prisma.$executeRawUnsafe('TRUNCATE "Notification", "Recipient", "ChainWrite", "AuditEvent", "ReportVersion", "StoredFile", "Engagement", "Client", "User", "IssuerOrg" CASCADE');
  const org = await prisma.issuerOrg.create({ data: { name: 'Example Audit OOD' } });
  const other = await prisma.issuerOrg.create({ data: { name: 'Another Firm' } });
  const make = async (orgId: string, email: string, role: 'PREPARER' | 'APPROVER' | 'ADMIN' | 'VIEWER'): Promise<SessionUser> => {
    const user = await prisma.user.create({ data: { orgId, email, name: email, role, passwordHash: 'x' } });
    return { id: user.id, email, name: email, role, orgId, mfa: role === 'APPROVER' || role === 'ADMIN' ? 'VERIFIED' : 'NOT_REQUIRED' };
  };
  preparer = await make(org.id, 'preparer@example.test', 'PREPARER');
  approver = await make(org.id, 'approver@example.test', 'APPROVER');
  admin = await make(org.id, 'admin@example.test', 'ADMIN');
  viewer = await make(org.id, 'viewer@example.test', 'VIEWER');
  outsider = await make(other.id, 'outsider@example.test', 'ADMIN');
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function engagement() {
  return createEngagement(preparer, { clientName: 'Example Manufacturing AD', registrationNumber: '123456789', country: 'BG', engagementRef: 'ENG-2026-050', periodEnd: '2025-12-31', reportType: 'STANDALONE' });
}

async function confirmedVersion(engagementId: string, file: string, reasonCode: 'INITIAL' | 'CORRECTION') {
  const uploaded = await uploadVersion(preparer, { engagementId, reasonCode, bytes: fixture(file) });
  await confirmOpinion(preparer, { versionId: uploaded.id, opinionType: 'QUALIFIED', text: OPINION, reportDate: '2026-03-31' });
  return prisma.reportVersion.findUniqueOrThrow({ where: { id: uploaded.id }, select: { id: true, version: true, engagementId: true } });
}

const queue = (version: { id: string; version: number; engagementId: string }) => prisma.$transaction((tx) => queueSupersededNotices(tx, version, admin.orgId, clock));

/** A transport that records what it was handed, failing as told. */
function fakeTransport(fail?: (message: MailMessage, n: number) => Error | null) {
  const sent: MailMessage[] = [];
  let n = 0;
  const transport: MailTransport = {
    async send(message) {
      n += 1;
      const error = fail?.(message, n);
      if (error) throw error;
      sent.push(message);
    },
  };
  return { transport, sent };
}

const deliver = (transport: MailTransport) => deliverNotifications({ prisma, transport, appUrl: APP_URL, now: () => clock });

describe('keeping the list of recipients', () => {
  it('is for a preparer or an admin, within their own firm', async () => {
    const e = await engagement();
    const input = { engagementId: e.id, name: 'Maria Petrova', email: 'Maria.Petrova@Lender.example', locale: 'bg' as const };
    await expect(addRecipient(viewer, input)).rejects.toBeInstanceOf(AccessError);
    await expect(addRecipient(approver, input)).rejects.toBeInstanceOf(AccessError);
    await expectIntake(addRecipient(outsider, input), 'NOT_FOUND');

    const { id } = await addRecipient(preparer, input);
    await addRecipient(admin, { ...input, name: 'Georgi Ivanov', email: 'g.ivanov@regulator.example', locale: 'en' });
    const list = await listRecipients(preparer, e.id);
    expect(list.map((r) => [r.name, r.email, r.locale])).toEqual([
      ['Maria Petrova', 'maria.petrova@lender.example', 'bg'],
      ['Georgi Ivanov', 'g.ivanov@regulator.example', 'en'],
    ]);
    expect(await listRecipients(outsider, e.id)).toEqual([]);

    // The audit log names ids, never the person or the address.
    const event = await prisma.auditEvent.findFirstOrThrow({ where: { action: 'recipient.added', subjectId: id } });
    expect(event).toMatchObject({ actorId: preparer.id, subjectType: 'Recipient' });
    expect(JSON.stringify(event.data)).not.toMatch(/maria|lender/i);
  });

  it('holds one live entry per address, which may be added again once removed', async () => {
    const e = await engagement();
    const input = { engagementId: e.id, name: 'Maria Petrova', email: 'maria@lender.example', locale: 'en' as const };
    const { id } = await addRecipient(preparer, input);
    await expectIntake(addRecipient(admin, { ...input, email: ' MARIA@lender.example ' }), 'RECIPIENT_EXISTS');

    await expect(removeRecipient(viewer, id)).rejects.toBeInstanceOf(AccessError);
    await expectIntake(removeRecipient(outsider, id), 'NOT_FOUND');
    await removeRecipient(admin, id);
    await expectIntake(removeRecipient(admin, id), 'NOT_FOUND');
    expect(await listRecipients(preparer, e.id)).toEqual([]);

    // The removed row stays, so who was told what can still be read.
    expect(await prisma.recipient.findUniqueOrThrow({ where: { id } })).toMatchObject({ removedById: admin.id, removedAt: expect.any(Date) });
    await addRecipient(preparer, input);
    expect(await prisma.recipient.count({ where: { engagementId: e.id } })).toBe(2);
    expect(await verifyAuditChain(prisma, admin.orgId)).toMatchObject({ ok: true });
  });

  it('holds at most 50 live recipients per engagement, so the list shows them all', async () => {
    const e = await engagement();
    await prisma.recipient.createMany({
      data: Array.from({ length: MAX_RECIPIENTS }, (_, i) => ({ engagementId: e.id, name: `R${i}`, email: `r${i}@example.test`, locale: 'en', addedById: preparer.id })),
    });
    await expectIntake(addRecipient(preparer, { engagementId: e.id, name: 'One more', email: 'more@example.test', locale: 'en' }), 'RECIPIENT_LIMIT');
    expect(await listRecipients(preparer, e.id)).toHaveLength(MAX_RECIPIENTS);
    const first = await prisma.recipient.findFirstOrThrow({ where: { email: 'r0@example.test' } });
    await removeRecipient(preparer, first.id);
    await addRecipient(preparer, { engagementId: e.id, name: 'One more', email: 'more@example.test', locale: 'en' });
  });

  it('refuses, in the database too, an address that is not lower case or a language it cannot write', async () => {
    const e = await engagement();
    const base = { engagementId: e.id, name: 'X', addedById: preparer.id };
    await expect(prisma.recipient.create({ data: { ...base, email: 'Upper@example.test', locale: 'en' } })).rejects.toThrow(/Recipient_email_lower/);
    await expect(prisma.recipient.create({ data: { ...base, email: 'x@example.test', locale: 'de' } })).rejects.toThrow(/Recipient_locale/);
  });
});

describe('queuing notices', () => {
  it('queues nothing for version 1, and one notice per live recipient when version 2 completes', async () => {
    const e = await engagement();
    const v1 = await confirmedVersion(e.id, 'en-unmodified.pdf', 'INITIAL');
    const kept = await addRecipient(preparer, { engagementId: e.id, name: 'Maria Petrova', email: 'maria@lender.example', locale: 'bg' });
    const gone = await addRecipient(preparer, { engagementId: e.id, name: 'Georgi Ivanov', email: 'georgi@regulator.example', locale: 'en' });
    await removeRecipient(preparer, gone.id);

    expect(await queue(v1)).toBe(0);
    const v2 = await confirmedVersion(e.id, 'en-qualified.pdf', 'CORRECTION');
    expect(await queue(v2)).toBe(1);
    expect(await prisma.notification.findMany({ select: { recipientId: true, reportVersionId: true, status: true } })).toEqual([{ recipientId: kept.id, reportVersionId: v2.id, status: 'PENDING' }]);
    // Queuing again adds nothing, and logs nothing.
    expect(await queue(v2)).toBe(0);
    expect(await prisma.auditEvent.count({ where: { action: 'notification.queued' } })).toBe(1);
  });

  it('cancels what was not yet sent when a recipient is removed', async () => {
    const e = await engagement();
    await confirmedVersion(e.id, 'en-unmodified.pdf', 'INITIAL');
    const r = await addRecipient(preparer, { engagementId: e.id, name: 'Maria Petrova', email: 'maria@lender.example', locale: 'en' });
    await queue(await confirmedVersion(e.id, 'en-qualified.pdf', 'CORRECTION'));
    await removeRecipient(admin, r.id);
    expect(await prisma.notification.findFirstOrThrow({ where: { recipientId: r.id } })).toMatchObject({ status: 'CANCELLED' });
    expect((await prisma.auditEvent.findFirstOrThrow({ where: { action: 'recipient.removed' } })).data).toEqual({ cancelledNotifications: 1 });
  });
});

describe('the mailer', () => {
  async function queued(recipients: { name: string; email: string; locale: 'en' | 'bg' }[]) {
    const e = await engagement();
    await confirmedVersion(e.id, 'en-unmodified.pdf', 'INITIAL');
    const ids = [];
    for (const r of recipients) ids.push((await addRecipient(preparer, { engagementId: e.id, ...r })).id);
    const v2 = await confirmedVersion(e.id, 'en-qualified.pdf', 'CORRECTION');
    await queue(v2);
    const familyId = (await prisma.engagement.findUniqueOrThrow({ where: { id: e.id } })).familyId;
    return { recipientIds: ids, v2, familyId };
  }

  it('sends each notice once, in the recipient’s language, with links and no report, opinion or figure', async () => {
    const { familyId } = await queued([
      { name: 'Maria Petrova', email: 'maria@lender.example', locale: 'bg' },
      { name: 'Georgi Ivanov', email: 'georgi@regulator.example', locale: 'en' },
    ]);
    const { transport, sent } = fakeTransport();
    const report = await deliver(transport);
    expect(report.sent).toHaveLength(2);
    expect(sent.map((m) => m.to).sort()).toEqual(['georgi@regulator.example', 'maria@lender.example']);
    const bg = sent.find((m) => m.to === 'maria@lender.example')!;
    expect(bg.subject).toContain('нова версия');
    for (const m of sent) {
      expect(m.text).toContain(`https://anchor.example.test/r/${familyId}/latest`);
      expect(m.text).toContain('https://anchor.example.test/verify');
      expect(m.text).toContain('ENG-2026-050');
      expect(m.text).not.toContain(OPINION);
      expect(m.text).not.toMatch(/QUALIFIED|opinion type/i);
      expect(Object.keys(m).sort()).toEqual(['subject', 'text', 'to']);
    }
    expect(await prisma.notification.findMany({ select: { status: true, sentAt: true, attempts: true } })).toEqual([
      { status: 'SENT', sentAt: clock, attempts: 1 },
      { status: 'SENT', sentAt: clock, attempts: 1 },
    ]);
    expect(await prisma.auditEvent.count({ where: { action: 'notification.sent' } })).toBe(2);

    // Nothing is left to send.
    const again = fakeTransport();
    expect((await deliver(again.transport)).sent).toEqual([]);
    expect(again.sent).toEqual([]);
    expect(await verifyAuditChain(prisma, admin.orgId)).toMatchObject({ ok: true });
  });

  it('retries a failure, keeps a name for it rather than what the server said, and gives up after five attempts', async () => {
    await queued([{ name: 'Maria Petrova', email: 'maria@lender.example', locale: 'en' }]);
    const refused = () => Object.assign(new Error('550 5.1.1 <maria@lender.example>: Recipient address rejected'), { code: 'EENVELOPE' });
    const { transport, sent } = fakeTransport(refused);

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const report = await deliver(transport);
      expect(report.retrying).toHaveLength(1);
      const row = await prisma.notification.findFirstOrThrow();
      expect(row).toMatchObject({ status: 'PENDING', attempts: attempt, lastError: 'EENVELOPE', leaseUntil: null });
    }
    expect((await deliver(transport)).failed).toHaveLength(1);
    expect(await prisma.notification.findFirstOrThrow()).toMatchObject({ status: 'FAILED', attempts: 5, lastError: 'EENVELOPE' });
    expect(sent).toEqual([]);
    const failed = await prisma.auditEvent.findFirstOrThrow({ where: { action: 'notification.failed' } });
    expect(failed.data).toMatchObject({ reason: 'EENVELOPE', attempts: 5 });
    expect(JSON.stringify(failed.data)).not.toContain('lender');
    // A FAILED notice is for a person to look at; the mailer leaves it.
    expect((await deliver(fakeTransport().transport)).sent).toEqual([]);
  });

  it('a failure after a retry still sends', async () => {
    await queued([{ name: 'Maria Petrova', email: 'maria@lender.example', locale: 'en' }]);
    const { transport, sent } = fakeTransport((_, n) => (n === 1 ? Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) : null));
    expect((await deliver(transport)).retrying).toHaveLength(1);
    expect((await deliver(transport)).sent).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(await prisma.notification.findFirstOrThrow()).toMatchObject({ status: 'SENT', attempts: 2, lastError: null });
  });

  it('leaves a notice another mailer holds until its lease runs out, then sends it (at least once)', async () => {
    await queued([{ name: 'Maria Petrova', email: 'maria@lender.example', locale: 'en' }]);
    // A mailer claimed it and died before sending or marking it.
    await prisma.notification.updateMany({ data: { leaseUntil: new Date(clock.getTime() + 60_000), attempts: 1 } });
    const { transport, sent } = fakeTransport();
    expect((await deliver(transport)).sent).toEqual([]);
    clock = new Date(clock.getTime() + 61_000);
    expect((await deliver(transport)).sent).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(await prisma.notification.findFirstOrThrow()).toMatchObject({ status: 'SENT', attempts: 2 });
  });

  it('cancels, rather than sends, a notice whose recipient was removed after it was claimed', async () => {
    const { recipientIds } = await queued([{ name: 'Maria Petrova', email: 'maria@lender.example', locale: 'en' }]);
    // Removed by a path that did not cancel it (the use case does; this is the mailer’s own check).
    await prisma.recipient.update({ where: { id: recipientIds[0] }, data: { removedAt: clock, removedById: admin.id } });
    const { transport, sent } = fakeTransport();
    expect((await deliver(transport)).cancelled).toHaveLength(1);
    expect(sent).toEqual([]);
    expect(await prisma.notification.findFirstOrThrow()).toMatchObject({ status: 'CANCELLED' });
  });
});
