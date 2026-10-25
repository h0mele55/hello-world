import type { Prisma } from '@/generated/prisma/client';
import { appendAuditEvent } from '@/lib/audit';

/**
 * When a version becomes COMPLETE and supersedes an earlier one, everyone
 * listed as holding the engagement's report is queued an email, in the same
 * transaction, so a completed version and its notices exist together or not
 * at all. The mailer sends them (src/lib/notifications/mailer.ts). Version 1
 * supersedes nothing, so it queues nothing.
 */
export async function queueSupersededNotices(
  tx: Prisma.TransactionClient,
  version: { id: string; version: number; engagementId: string },
  orgId: string,
  now: Date,
): Promise<number> {
  if (version.version < 2) return 0;
  const recipients = await tx.recipient.findMany({ where: { engagementId: version.engagementId, removedAt: null }, select: { id: true } });
  if (recipients.length === 0) return 0;
  const { count } = await tx.notification.createMany({
    data: recipients.map((r) => ({ recipientId: r.id, reportVersionId: version.id })),
    skipDuplicates: true,
  });
  if (count === 0) return 0;
  await appendAuditEvent(tx, { orgId, actorId: null, action: 'notification.queued', subjectType: 'ReportVersion', subjectId: version.id, data: { count } }, now);
  return count;
}
