import { getFormatter, getTranslations } from 'next-intl/server';
import { Card } from '@inflect/ui/components/ui/card';
import { StatusBadge } from '@inflect/ui/components/ui/status-badge';
import { Heading } from '@inflect/ui/components/ui/typography';
import type { SessionUser } from '@/auth';
import type { NotificationStatus } from '@/generated/prisma/enums';
import { listRecipients } from '@/lib/reports/recipients';
import { mayDo } from '@/lib/roles';
import { RecipientForm } from './recipient-form';
import { RemoveRecipientButton } from './remove-recipient-button';

const STATUS_VARIANT = { PENDING: 'info', SENT: 'success', FAILED: 'error', CANCELLED: 'neutral' } as const satisfies Record<NotificationStatus, string>;

/**
 * Who holds a copy of this engagement's report. When a newer version
 * supersedes it, each is emailed a link to the latest version's record:
 * never the report, the opinion or a figure (decision #8).
 */
export async function RecipientsCard({ user, engagementId }: { user: SessionUser; engagementId: string }) {
  const t = await getTranslations('recipients');
  const format = await getFormatter();
  const recipients = await listRecipients(user, engagementId);
  const canManage = mayDo(user.role, 'manageRecipients');

  return (
    <Card className="flex flex-col gap-default" data-testid="recipients">
      <Heading level={2}>{t('title')}</Heading>
      <p className="text-content-muted">{t('intro')}</p>
      {recipients.length === 0 ? (
        <p className="text-content-muted" data-testid="no-recipients">
          {t('none')}
        </p>
      ) : (
        <ul className="flex flex-col gap-tight" data-testid="recipient-list">
          {recipients.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-tight" data-testid="recipient" data-email={r.email}>
              <span className="font-medium text-content-emphasis">{r.name}</span>
              <span className="text-content-muted">{r.email}</span>
              <StatusBadge variant="neutral">{t(`locales.${r.locale as 'en' | 'bg'}`)}</StatusBadge>
              {r.last ? (
                <StatusBadge variant={STATUS_VARIANT[r.last.status]} data-testid="recipient-last" data-kind={r.last.kind}>
                  {t(`${r.last.kind === 'REVOKED' ? 'lastRevoked' : 'last'}.${r.last.status}`, { version: r.last.version, when: format.dateTime(new Date(r.last.at), { dateStyle: 'medium', timeZone: 'UTC' }) })}
                </StatusBadge>
              ) : null}
              {canManage ? <RemoveRecipientButton recipientId={r.id} name={r.name} /> : null}
            </li>
          ))}
        </ul>
      )}
      {canManage ? <RecipientForm engagementId={engagementId} /> : null}
    </Card>
  );
}
