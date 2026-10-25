import 'server-only';
import type { SessionUser } from '@/auth';
import { Prisma } from '@/generated/prisma/client';
import { appendAuditEvent } from '@/lib/audit';
import { db } from '@/lib/db';
import type { EmailLocale } from '@/lib/notifications/email';
import { requireRole } from '@/lib/roles';
import { IntakeError } from './intake';

/**
 * An engagement's recipients: the people holding a copy of its report, told
 * by email when a newer version supersedes it. A preparer or admin keeps the
 * list. Removing someone keeps their row (and what they were sent), so the
 * record of who was told stays readable; the audit log names ids only.
 */

export interface NewRecipient {
  engagementId: string;
  name: string;
  email: string;
  locale: EmailLocale;
}

/** At most this many live recipients per engagement: the list shows them all, and one completed version queues at most this many emails. */
export const MAX_RECIPIENTS = 50;

const isUniqueViolation = (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

export async function addRecipient(user: SessionUser, input: NewRecipient) {
  requireRole(user, 'manageRecipients');
  return db().$transaction(async (tx) => {
    const engagement = await tx.engagement.findFirst({ where: { id: input.engagementId, client: { orgId: user.orgId } }, select: { id: true } });
    if (!engagement) throw new IntakeError('NOT_FOUND');
    // Two adds at once cannot both pass the count. NO KEY UPDATE, so inserts that reference the engagement are not blocked.
    await tx.$queryRaw`SELECT "id" FROM "Engagement" WHERE "id" = ${engagement.id} FOR NO KEY UPDATE`;
    if ((await tx.recipient.count({ where: { engagementId: engagement.id, removedAt: null } })) >= MAX_RECIPIENTS) throw new IntakeError('RECIPIENT_LIMIT');
    let recipient;
    try {
      recipient = await tx.recipient.create({
        data: { engagementId: engagement.id, name: input.name.trim(), email: input.email.trim().toLowerCase(), locale: input.locale, addedById: user.id },
        select: { id: true },
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new IntakeError('RECIPIENT_EXISTS');
      throw error;
    }
    await appendAuditEvent(tx, {
      orgId: user.orgId,
      actorId: user.id,
      action: 'recipient.added',
      subjectType: 'Recipient',
      subjectId: recipient.id,
      data: { engagementId: engagement.id },
    });
    return recipient;
  });
}

/** Removes a recipient from the list; anything not yet sent to them is cancelled with it. */
export async function removeRecipient(user: SessionUser, recipientId: string) {
  requireRole(user, 'manageRecipients');
  return db().$transaction(async (tx) => {
    const now = new Date();
    const { count } = await tx.recipient.updateMany({
      where: { id: recipientId, removedAt: null, engagement: { client: { orgId: user.orgId } } },
      data: { removedAt: now, removedById: user.id },
    });
    if (count !== 1) throw new IntakeError('NOT_FOUND');
    const cancelled = await tx.notification.updateMany({ where: { recipientId, status: 'PENDING' }, data: { status: 'CANCELLED', leaseUntil: null } });
    await appendAuditEvent(tx, {
      orgId: user.orgId,
      actorId: user.id,
      action: 'recipient.removed',
      subjectType: 'Recipient',
      subjectId: recipientId,
      data: { cancelledNotifications: cancelled.count },
    });
  });
}

/** An engagement's current recipients, with what was last sent to each. */
export async function listRecipients(user: SessionUser, engagementId: string) {
  const rows = await db().recipient.findMany({
    where: { engagementId, removedAt: null, engagement: { client: { orgId: user.orgId } } },
    orderBy: { addedAt: 'asc' },
    take: MAX_RECIPIENTS,
    select: {
      id: true,
      name: true,
      email: true,
      locale: true,
      addedAt: true,
      notifications: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { kind: true, status: true, sentAt: true, createdAt: true, reportVersion: { select: { version: true } } },
      },
    },
  });
  return rows.map((r) => {
    const last = r.notifications[0];
    return {
      id: r.id,
      name: r.name,
      email: r.email,
      locale: r.locale,
      addedAt: r.addedAt.toISOString(),
      last: last ? { kind: last.kind, status: last.status, version: last.reportVersion.version, at: (last.sentAt ?? last.createdAt).toISOString() } : null,
    };
  });
}

export type RecipientView = Awaited<ReturnType<typeof listRecipients>>[number];
