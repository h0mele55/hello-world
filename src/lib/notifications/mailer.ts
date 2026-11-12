import type { PrismaClient } from '@/generated/prisma/client';
import { appendAuditEvent } from '@/lib/audit';
import { EMAIL_LOCALES, revokedEmail, supersededEmail, type EmailLocale } from './email';

/**
 * Sends the queued notices (src/lib/notifications/queue.ts), one row at a
 * time under a lease, as the anchoring worker works its journal. Sending is
 * at least once: a mailer that dies after the server accepted a message but
 * before it marked the row sent sends it again when the lease runs out. A
 * duplicate notice is harmless; a lost one is not.
 *
 * Each message is built here, from the database, when it is sent: names, the
 * version and the links, never the report, the opinion or a figure.
 *
 * A failed send waits before it is tried again (#148), the wait doubling from
 * a minute up to four hours. A server that turns the address away for good (a
 * 5xx reply) is given MAX_PERMANENT_ATTEMPTS, a quarter of an hour in all; one
 * that cannot be reached, answers "try later" (4xx), or refuses the firm's own
 * sign-in is given MAX_TRANSIENT_ATTEMPTS, about three days, since that is
 * the firm's outage and not the recipient's address. Either way a FAILED
 * notice is for a person.
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
  /** After this many failed attempts, the last a permanent rejection, a notice is FAILED, for a person to look at. */
  maxAttempts?: number;
  leaseMs?: number;
}

export interface MailerReport {
  sent: string[];
  retrying: string[];
  failed: string[];
  cancelled: string[];
}

/** Attempts at a notice the server rejects for good: about a quarter of an hour, by the waits below. */
export const MAX_PERMANENT_ATTEMPTS = 5;
/** Attempts at a notice while the server cannot be reached or asks to try later: about three days. */
export const MAX_TRANSIENT_ATTEMPTS = 24;
const FIRST_WAIT_MS = 60_000;
const LONGEST_WAIT_MS = 4 * 3_600_000;

/** How long a notice waits after its `attempts`th failure: doubling from a minute, at most four hours. */
export function retryWaitMs(attempts: number): number {
  return Math.min(FIRST_WAIT_MS * 2 ** Math.max(0, Math.min(attempts - 1, 30)), LONGEST_WAIT_MS);
}

/**
 * Whether the server turned the message away for good: a 5xx reply
 * (nodemailer's `responseCode`), unless it refused the firm's own sign-in,
 * which no number of attempts at this address will change. Anything without
 * a reply (a connection refused, a timeout, a TLS failure) is not.
 */
export function isPermanentRejection(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const { code, responseCode } = error as { code?: unknown; responseCode?: unknown };
  if (code === 'EAUTH' || code === 'ENOAUTH') return false;
  return typeof responseCode === 'number' && responseCode >= 500 && responseCode < 600;
}

/** A name for an error, never its message: an SMTP reply can echo addresses and content. */
const errorName = (error: unknown) =>
  error instanceof Error ? (('code' in error && typeof error.code === 'string' && error.code) || error.name) : typeof error;

export async function deliverNotifications(deps: MailerDeps): Promise<MailerReport> {
  const now = deps.now ?? (() => new Date());
  const maxAttempts = deps.maxAttempts ?? MAX_PERMANENT_ATTEMPTS;
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
        kind: true,
        recipient: { select: { id: true, name: true, email: true, locale: true, removedAt: true } },
        reportVersion: {
          select: {
            id: true,
            version: true,
            // A REVOKED notice names the reason of the revocation in effect, never its sealed note.
            revocations: { where: { status: 'REVOKED' }, select: { reason: true }, orderBy: { revokedAt: 'desc' }, take: 1 },
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
    const facts = {
      locale,
      recipientName: recipient.name,
      firm: org.name,
      client: version.engagement.client.name,
      engagementRef: version.engagement.engagementRef,
      periodEnd: version.engagement.periodEnd.toISOString().slice(0, 10),
      version: version.version,
      latestUrl: `${appUrl}/r/${version.engagement.familyId}/latest`,
      verifyUrl: `${appUrl}/verify`,
    };
    const revocation = version.revocations[0];
    if (notice.kind === 'REVOKED' && !revocation) {
      // Queued only when a version is REVOKED, so this is a broken row: a person looks at it.
      await deps.prisma.$transaction(async (tx) => {
        await tx.notification.updateMany({ where: { id: notice.id, status: 'PENDING' }, data: { status: 'FAILED', lastError: 'NO_REVOCATION', leaseUntil: null } });
        await appendAuditEvent(tx, { orgId: org.id, actorId: null, action: 'notification.failed', subjectType: 'Notification', subjectId: notice.id, data: { recipientId: recipient.id, reportVersionId: version.id, reason: 'NO_REVOCATION', attempts: row.attempts } }, now());
      });
      report.failed.push(notice.id);
      continue;
    }
    const { subject, text } = notice.kind === 'REVOKED' ? revokedEmail({ ...facts, reason: revocation.reason }) : supersededEmail(facts);

    try {
      await deps.transport.send({ to: recipient.email, subject, text });
    } catch (error) {
      const reason = errorName(error);
      const final = row.attempts >= (isPermanentRejection(error) ? maxAttempts : Math.max(maxAttempts, MAX_TRANSIENT_ATTEMPTS));
      // Not tried again before the wait is over: the claim takes only a lease that has run out.
      const retryAt = new Date(now().getTime() + retryWaitMs(row.attempts));
      await deps.prisma.$transaction(async (tx) => {
        await tx.notification.updateMany({ where: { id: notice.id, status: 'PENDING' }, data: { status: final ? 'FAILED' : 'PENDING', lastError: reason, leaseUntil: final ? null : retryAt } });
        if (final) {
          await appendAuditEvent(tx, { orgId: org.id, actorId: null, action: 'notification.failed', subjectType: 'Notification', subjectId: notice.id, data: { recipientId: recipient.id, reportVersionId: version.id, reason, attempts: row.attempts } }, now());
        }
      });
      (final ? report.failed : report.retrying).push(notice.id);
      continue;
    }

    // It went out: recorded as sent whatever happened meanwhile (#158). A recipient
    // removed during the send cancelled a notice that was delivered all the same.
    await deps.prisma.$transaction(async (tx) => {
      const sentAt = now();
      const sent = { status: 'SENT' as const, sentAt, lastError: null, leaseUntil: null };
      const { count } = await tx.notification.updateMany({ where: { id: notice.id, status: 'PENDING' }, data: sent });
      const cancelledMeanwhile = count === 0 && (await tx.notification.updateMany({ where: { id: notice.id, status: 'CANCELLED' }, data: sent })).count === 1;
      await appendAuditEvent(
        tx,
        { orgId: org.id, actorId: null, action: 'notification.sent', subjectType: 'Notification', subjectId: notice.id, data: { recipientId: recipient.id, reportVersionId: version.id, ...(cancelledMeanwhile ? { cancelledMeanwhile: true } : {}) } },
        sentAt,
      );
    });
    report.sent.push(notice.id);
  }
  return report;
}
