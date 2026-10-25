import type { PrismaClient } from '@/generated/prisma/client';
import { appendAuditEvent } from '@/lib/audit';
import { EMAIL_LOCALES, supersededEmail, type EmailLocale } from './email';

/**
 * Sends the queued notices (src/lib/notifications/queue.ts), one row at a
 * time under a lease, as the anchoring worker works its journal. Sending is
 * at least once: a mailer that dies after the server accepted a message but
 * before it marked the row sent sends it again when the lease runs out. A
 * duplicate notice is harmless; a lost one is not.
 *
 * Each message is built here, from the database, when it is sent: names, the
 * version and the links, never the report, the opinion or a figure.
 */

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface MailTransport {
  send(message: MailMessage): Promise<void>;
}

export interface MailerDeps {
  prisma: PrismaClient;
  transport: MailTransport;
  /** The app's public origin: links point at <appUrl>/r/<familyId>/latest and <appUrl>/verify. */
  appUrl: string;
  now?: () => Date;
  /** After this many failed attempts a notice is FAILED, for a person to look at. */
  maxAttempts?: number;
  leaseMs?: number;
}

export interface MailerReport {
  sent: string[];
  retrying: string[];
  failed: string[];
  cancelled: string[];
}

/** A name for an error, never its message: an SMTP reply can echo addresses and content. */
const errorName = (error: unknown) =>
  error instanceof Error ? (('code' in error && typeof error.code === 'string' && error.code) || error.name) : typeof error;

export async function deliverNotifications(deps: MailerDeps): Promise<MailerReport> {
  const now = deps.now ?? (() => new Date());
  const maxAttempts = deps.maxAttempts ?? 5;
  const leaseMs = deps.leaseMs ?? 60_000;
  const appUrl = deps.appUrl.replace(/\/+$/, '');
  const report: MailerReport = { sent: [], retrying: [], failed: [], cancelled: [] };
  const done: string[] = [];

  for (;;) {
    const at = now();
    const claimed = await deps.prisma.$queryRaw<{ id: string; attempts: number }[]>`
      UPDATE "Notification" SET "leaseUntil" = ${new Date(at.getTime() + leaseMs)}, "attempts" = "attempts" + 1
      WHERE "id" = (
        SELECT "id" FROM "Notification"
        WHERE "status" = 'PENDING' AND ("leaseUntil" IS NULL OR "leaseUntil" < ${at}) AND NOT ("id" = ANY(${done}::text[]))
        ORDER BY "createdAt" LIMIT 1
        FOR UPDATE SKIP LOCKED)
      RETURNING "id", "attempts"`;
    const row = claimed[0];
    if (!row) break;
    done.push(row.id);

    const notice = await deps.prisma.notification.findUniqueOrThrow({
      where: { id: row.id },
      select: {
        id: true,
        recipient: { select: { id: true, name: true, email: true, locale: true, removedAt: true } },
        reportVersion: {
          select: {
            id: true,
            version: true,
            engagement: { select: { engagementRef: true, periodEnd: true, familyId: true, client: { select: { name: true, org: { select: { id: true, name: true } } } } } },
          },
        },
      },
    });
    const { recipient, reportVersion: version } = notice;
    const org = version.engagement.client.org;
    if (recipient.removedAt) {
      await deps.prisma.notification.updateMany({ where: { id: notice.id, status: 'PENDING' }, data: { status: 'CANCELLED', leaseUntil: null } });
      report.cancelled.push(notice.id);
      continue;
    }

    const locale: EmailLocale = (EMAIL_LOCALES as readonly string[]).includes(recipient.locale) ? (recipient.locale as EmailLocale) : 'en';
    const { subject, text } = supersededEmail({
      locale,
      recipientName: recipient.name,
      firm: org.name,
      client: version.engagement.client.name,
      engagementRef: version.engagement.engagementRef,
      periodEnd: version.engagement.periodEnd.toISOString().slice(0, 10),
      version: version.version,
      latestUrl: `${appUrl}/r/${version.engagement.familyId}/latest`,
      verifyUrl: `${appUrl}/verify`,
    });

    try {
      await deps.transport.send({ to: recipient.email, subject, text });
    } catch (error) {
      const reason = errorName(error);
      const final = row.attempts >= maxAttempts;
      await deps.prisma.$transaction(async (tx) => {
        await tx.notification.updateMany({ where: { id: notice.id, status: 'PENDING' }, data: { status: final ? 'FAILED' : 'PENDING', lastError: reason, leaseUntil: null } });
        if (final) {
          await appendAuditEvent(tx, { orgId: org.id, actorId: null, action: 'notification.failed', subjectType: 'Notification', subjectId: notice.id, data: { recipientId: recipient.id, reportVersionId: version.id, reason, attempts: row.attempts } }, now());
        }
      });
      (final ? report.failed : report.retrying).push(notice.id);
      continue;
    }

    await deps.prisma.$transaction(async (tx) => {
      await tx.notification.updateMany({ where: { id: notice.id, status: 'PENDING' }, data: { status: 'SENT', sentAt: now(), lastError: null, leaseUntil: null } });
      await appendAuditEvent(tx, { orgId: org.id, actorId: null, action: 'notification.sent', subjectType: 'Notification', subjectId: notice.id, data: { recipientId: recipient.id, reportVersionId: version.id } }, now());
    });
    report.sent.push(notice.id);
  }
  return report;
}
