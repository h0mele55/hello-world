import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { buttonVariants } from '@inflect/ui/components/ui/button-variants';
import { Card } from '@inflect/ui/components/ui/card';
import { EmptyState } from '@inflect/ui/components/ui/empty-state';
import { Heading } from '@inflect/ui/components/ui/typography';
import { requireUser } from '@/lib/page-auth';
import { VersionStatusBadge } from '@/components/reports/version-status-badge';
import { listEngagements } from '@/lib/reports/queries';
import { mayDo } from '@/lib/roles';

export default async function ReportsPage() {
  const user = await requireUser();
  const t = await getTranslations('reports');
  const engagements = await listEngagements(user);
  const newButton =
    mayDo(user.role, 'prepare') ? (
      <Link href="/reports/new" className={buttonVariants({ variant: 'primary' })} data-testid="new-engagement">
        {t('newEngagement')}
      </Link>
    ) : null;

  return (
    <main className="flex flex-col gap-section">
      <div className="flex flex-wrap items-center justify-between gap-default">
        <Heading level={1}>{t('title')}</Heading>
        {newButton}
      </div>
      {engagements.length === 0 ? (
        <EmptyState title={t('empty.title')} description={t('empty.description')} />
      ) : (
        <ul className="flex flex-col gap-default" data-testid="engagement-list">
          {engagements.map((e) => (
            <li key={e.id}>
              <Card className="flex flex-col gap-compact">
                <Link href={`/reports/${e.id}`} className="text-lg font-semibold text-content-emphasis hover:underline">
                  {e.clientName}
                </Link>
                <p className="text-content-muted">
                  {t('summary', { registrationNumber: e.registrationNumber, periodEnd: e.periodEnd, reportType: t(`reportTypes.${e.reportType}`), engagementRef: e.engagementRef })}
                </p>
                <div className="flex flex-wrap gap-tight">
                  {e.versions.length === 0 ? <span className="text-content-muted">{t('noVersions')}</span> : null}
                  {e.versions.map((v) => (
                    <Link key={v.id} href={`/reports/versions/${v.id}`} className="flex items-center gap-tight">
                      <span className="text-content-default">{t('versionLabel', { version: v.version })}</span>
                      <VersionStatusBadge status={v.status} />
                    </Link>
                  ))}
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
