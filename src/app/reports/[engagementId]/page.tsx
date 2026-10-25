import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Card } from '@inflect/ui/components/ui/card';
import { Heading } from '@inflect/ui/components/ui/typography';
import { requireUser } from '@/lib/page-auth';
import { UploadForm } from '@/components/reports/upload-form';
import { VersionStatusBadge } from '@/components/reports/version-status-badge';
import { getEngagement } from '@/lib/reports/queries';
import { mayDo } from '@/lib/roles';

export default async function EngagementPage({ params }: { params: Promise<{ engagementId: string }> }) {
  const user = await requireUser();
  const engagement = await getEngagement(user, (await params).engagementId);
  if (!engagement) notFound();
  const t = await getTranslations('reports');
  const tUpload = await getTranslations('upload');
  const hasDraft = engagement.versions.some((v) => v.status === 'DRAFT');
  const nextVersion = (engagement.versions.at(-1)?.version ?? 0) + 1;

  return (
    <main className="flex flex-col gap-section">
      <div className="flex flex-col gap-tight">
        <Heading level={1}>{engagement.clientName}</Heading>
        <p className="text-content-muted">
          {t('summary', { registrationNumber: engagement.registrationNumber, periodEnd: engagement.periodEnd, reportType: t(`reportTypes.${engagement.reportType}`), engagementRef: engagement.engagementRef })}
        </p>
      </div>
      <Card className="flex flex-col gap-compact">
        <Heading level={2}>{t('versions')}</Heading>
        {engagement.versions.length === 0 ? <p className="text-content-muted">{t('noVersions')}</p> : null}
        <ul className="flex flex-col gap-tight" data-testid="version-list">
          {engagement.versions.map((v) => (
            <li key={v.id}>
              <Link href={`/reports/versions/${v.id}`} className="flex items-center gap-tight hover:underline">
                <span>{t('versionLabel', { version: v.version })}</span>
                <VersionStatusBadge status={v.status} />
              </Link>
            </li>
          ))}
        </ul>
      </Card>
      {mayDo(user.role, 'prepare') ? (
        <Card className="flex flex-col gap-default">
          <Heading level={2}>{tUpload('title')}</Heading>
          {hasDraft ? <p className="text-content-muted">{tUpload('draftPending')}</p> : <UploadForm engagementId={engagement.id} nextVersion={nextVersion} />}
        </Card>
      ) : null}
    </main>
  );
}
