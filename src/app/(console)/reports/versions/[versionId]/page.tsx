import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Card } from '@inflect/ui/components/ui/card';
import { CopyButton } from '@inflect/ui/components/ui/copy-button';
import { StatusBadge } from '@inflect/ui/components/ui/status-badge';
import { Heading } from '@inflect/ui/components/ui/typography';
import { requireUser } from '@/lib/page-auth';
import { AnchoringPanel } from '@/components/reports/anchoring-panel';
import { ConfirmOpinionForm } from '@/components/reports/confirm-opinion-form';
import { PdfViewer } from '@/components/reports/pdf-viewer';
import { RevocationPanel } from '@/components/reports/revocation-panel';
import { VersionStatusBadge } from '@/components/reports/version-status-badge';
import { getVersion, IntakeError } from '@/lib/reports/intake';
import { mayDo } from '@/lib/roles';

async function load(versionId: string) {
  const user = await requireUser();
  try {
    return { user, version: await getVersion(user, versionId) };
  } catch (error) {
    if (error instanceof IntakeError && error.code === 'NOT_FOUND') notFound();
    throw error;
  }
}

function Commitment({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-tight">
      <span className="text-sm text-content-muted">{label}</span>
      <div className="flex items-center gap-tight">
        <code className="break-all font-mono text-sm text-content-default">{value}</code>
        <CopyButton value={value} label={label} />
      </div>
    </div>
  );
}

export default async function VersionPage({ params }: { params: Promise<{ versionId: string }> }) {
  const { user, version } = await load((await params).versionId);
  const t = await getTranslations('version');
  const tReports = await getTranslations('reports');
  const tTypes = await getTranslations('opinion.types');
  const { flags } = version;
  const warnings = (['javascript', 'embeddedFiles', 'xfa'] as const).filter((flag) => flags[flag]);
  const { extraction } = version;
  const initialPage = extraction.status === 'FOUND' ? extraction.pageRange[0] : extraction.status === 'CANDIDATES' ? extraction.candidates[0].pageRange[0] : 1;
  // Which of the PDF's reports the confirmed opinion was taken from (#77).
  const fromCandidate = extraction.status === 'CANDIDATES' && version.opinionCandidate !== null ? extraction.candidates[version.opinionCandidate] : undefined;

  return (
    <main className="flex flex-col gap-section">
      <div className="flex flex-col gap-tight">
        <Link href={`/reports/${version.engagement.id}`} className="text-content-muted hover:underline">
          {version.engagement.clientName} · {version.engagement.engagementRef}
        </Link>
        <div className="flex flex-wrap items-center gap-compact">
          <Heading level={1}>{tReports('versionLabel', { version: version.version })}</Heading>
          <VersionStatusBadge status={version.status} />
          {version.anchorOnly ? <StatusBadge variant="info">{t('anchorOnly')}</StatusBadge> : null}
        </div>
        {version.anchorOnly ? <p className="text-content-muted">{flags.signed ? t('anchorOnlySigned') : t('anchorOnlyProtected')}</p> : null}
        {warnings.map((flag) => (
          <StatusBadge key={flag} variant="warning" data-testid={`flag-${flag}`}>
            {t(`flags.${flag}`)}
          </StatusBadge>
        ))}
      </div>
      <div className="grid gap-section lg:grid-cols-2">
        <Card>
          <PdfViewer src={`/api/versions/${version.id}/file`} initialPage={initialPage} />
        </Card>
        <Card className="flex flex-col gap-default">
          {version.status === 'DRAFT' && mayDo(user.role, 'prepare') ? (
            <>
              <Heading level={2}>{t('confirmTitle')}</Heading>
              <ConfirmOpinionForm versionId={version.id} extraction={version.extraction} />
            </>
          ) : version.status === 'DRAFT' ? (
            <p className="text-content-muted">{t('awaitingPreparer')}</p>
          ) : (
            <div className="flex flex-col gap-default" data-testid="confirmed-opinion">
              <Heading level={2}>{t('confirmedTitle')}</Heading>
              <p>
                <span className="text-content-muted">{t('opinionType')}: </span>
                <strong data-testid="confirmed-type">{tTypes(version.opinionType!)}</strong>
              </p>
              <p>
                <span className="text-content-muted">{t('reportDate')}: </span>
                {version.reportDate}
              </p>
              {fromCandidate && extraction.status === 'CANDIDATES' ? (
                <p className="text-content-muted" data-testid="confirmed-candidate">
                  {t('fromCandidate', { n: version.opinionCandidate! + 1, count: extraction.candidates.length, from: fromCandidate.pageRange[0], to: fromCandidate.pageRange[1] })}
                </p>
              ) : null}
              <blockquote className="whitespace-pre-wrap border-l-2 border-border-default pl-default text-content-default" data-testid="confirmed-text">
                {version.confirmedOpinion}
              </blockquote>
              <Heading level={3}>{t('commitments')}</Heading>
              <p className="text-content-muted" data-testid="commitments-hint">
                {version.status === 'ANCHORED' || version.status === 'COMPLETE' || version.status === 'REVOKED' ? t('commitmentsOnChain') : t('commitmentsHint')}
              </p>
              <Commitment label={t('docHash')} value={version.docHash} />
              <Commitment label={t('opinionCommitment')} value={version.opinionCommitment!} />
              <Commitment label={t('manifestHash')} value={version.manifestHash!} />
            </div>
          )}
        </Card>
      </div>
      {version.status !== 'DRAFT' ? <AnchoringPanel user={user} versionId={version.id} status={version.status} /> : null}
      <RevocationPanel user={user} version={{ id: version.id, version: version.version, status: version.status, engagementRef: version.engagement.engagementRef }} />
    </main>
  );
}
