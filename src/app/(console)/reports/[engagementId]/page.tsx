import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Card } from '@inflect/ui/components/ui/card';
import { Heading } from '@inflect/ui/components/ui/typography';
import { requireUser } from '@/lib/page-auth';
import { VersionTimeline } from '@/components/console/version-timeline';
import { RecipientsCard } from '@/components/reports/recipients-card';
import { UploadForm } from '@/components/reports/upload-form';
import { getEngagementTimeline } from '@/lib/console/queries';
import { mayDo } from '@/lib/roles';

export default async function EngagementPage({ params }: { params: Promise<{ engagementId: string }> }) {
  const user = await requireUser();
  const engagement = await getEngagementTimeline(user, (await params).engagementId);
  if (!engagement) notFound();
  const t = await getTranslations('reports');
  const tUpload = await getTranslations('upload');
  const tConsole = await getTranslations('console.timeline');
  const hasDraft = engagement.versions.some((v) => v.status === 'DRAFT');
  const nextVersion = (engagement.versions[0]?.version ?? 0) + 1;

  return (
    <main className="flex flex-col gap-section">
      <div className="flex flex-col gap-tight">
        <Link href={`/clients/${engagement.client.id}`} className="text-content-muted hover:underline" data-testid="engagement-client-link">
          {tConsole('clientLink')}
        </Link>
        <Heading level={1}>{engagement.client.name}</Heading>
        <p className="text-content-muted">
          {t('summary', { registrationNumber: engagement.client.registrationNumber, periodEnd: engagement.periodEnd, reportType: t(`reportTypes.${engagement.reportType}`), engagementRef: engagement.engagementRef })}
        </p>
      </div>
      <Card className="flex flex-col gap-default">
        <Heading level={2}>{t('versions')}</Heading>
        <VersionTimeline versions={engagement.versions} />
      </Card>
      <RecipientsCard user={user} engagementId={engagement.id} />
      {mayDo(user.role, 'prepare') ? (
        <Card className="flex flex-col gap-default">
          <Heading level={2}>{tUpload('title')}</Heading>
          {hasDraft ? <p className="text-content-muted">{tUpload('draftPending')}</p> : <UploadForm engagementId={engagement.id} nextVersion={nextVersion} />}
        </Card>
      ) : null}
    </main>
  );
}
