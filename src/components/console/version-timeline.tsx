import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import { buttonVariants } from '@inflect/ui/components/ui/button-variants';
import { CopyButton } from '@inflect/ui/components/ui/copy-button';
import { StatusBadge } from '@inflect/ui/components/ui/status-badge';
import { VersionStatusBadge } from '@/components/reports/version-status-badge';
import { explorerBlockUrl, explorerTxUrl } from '@/lib/chain/explorer';
import type { TimelineVersion } from '@/lib/console/queries';

function Hash({ label, value, href, explorer, testId }: { label: string; value: string; href: string | null; explorer: string; testId: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-tight">
      <dt className="text-sm text-content-muted">{label}</dt>
      <dd className="flex min-w-0 items-center gap-tight">
        <code className="truncate font-mono text-sm text-content-default" title={value} data-testid={testId}>
          {value}
        </code>
        <CopyButton value={value} label={label} />
        {href ? (
          <a href={href} target="_blank" rel="noreferrer" className="shrink-0 text-sm text-content-info hover:underline">
            {explorer}
          </a>
        ) : null}
      </dd>
    </div>
  );
}

/**
 * An engagement's versions, newest first: who prepared and approved each,
 * why it was issued, where its anchor landed, and its download. A version
 * counts as anchored only once its block is final (rule 2), which is when the
 * worker sets its record id; until then there is no block to show.
 */
export async function VersionTimeline({ versions }: { versions: TimelineVersion[] }) {
  const t = await getTranslations('console.timeline');
  const tReports = await getTranslations('reports');
  const format = await getFormatter();
  const when = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });

  if (versions.length === 0) return <p className="text-content-muted">{tReports('noVersions')}</p>;
  // The version a copy of any earlier one resolves to: the newest with a final anchor.
  const latestOnChain = versions.findIndex((v) => v.recordId !== null);

  return (
    <ol className="flex flex-col" data-testid="version-timeline">
      {versions.map((v, index) => (
        <li key={v.id} className="relative flex gap-default pb-section last:pb-0" data-testid="timeline-version" data-version={v.version} data-status={v.status}>
          {/* The line runs from this version's dot down to the next one's. */}
          {index < versions.length - 1 ? <span aria-hidden="true" className="absolute left-[7px] top-5 bottom-0 w-px bg-border-default" /> : null}
          <span aria-hidden="true" className={`relative mt-1.5 h-[15px] w-[15px] shrink-0 rounded-full border-2 ${index === 0 ? 'border-brand-emphasis bg-brand-emphasis' : 'border-border-default bg-bg-default'}`} />
          <div className="flex min-w-0 flex-1 flex-col gap-compact">
            <div className="flex flex-wrap items-center gap-tight">
              <Link href={`/reports/versions/${v.id}`} className="font-semibold text-content-emphasis hover:underline" data-testid="timeline-version-link">
                {tReports('versionLabel', { version: v.version })}
              </Link>
              <VersionStatusBadge status={v.status} />
              <StatusBadge variant="neutral">{t(`reasons.${v.reasonCode}`)}</StatusBadge>
              {v.anchorOnly ? <StatusBadge variant="info">{t('anchorOnly')}</StatusBadge> : null}
              {index === latestOnChain ? <StatusBadge variant="success" data-testid="timeline-latest">{t('latest')}</StatusBadge> : null}
            </div>
            {v.revokedAt ? (
              <p className="text-content-error" data-testid="timeline-revoked">
                {t('revokedOn', { when: when(v.revokedAt) })}
              </p>
            ) : null}
            <dl className="grid gap-compact sm:grid-cols-2">
              <div className="flex flex-col gap-tight">
                <dt className="text-sm text-content-muted">{t('prepared')}</dt>
                <dd data-testid="timeline-prepared">{t('byAt', { who: v.preparedBy, when: when(v.uploadedAt) })}</dd>
              </div>
              <div className="flex flex-col gap-tight">
                <dt className="text-sm text-content-muted">{t('approved')}</dt>
                <dd data-testid="timeline-approved">{v.approvedBy && v.approvedAt ? t('byAt', { who: v.approvedBy, when: when(v.approvedAt) }) : <span className="text-content-muted">{t('notApproved')}</span>}</dd>
              </div>
              {v.recordId ? (
                <>
                  <div className="flex flex-col gap-tight">
                    <dt className="text-sm text-content-muted">{t('block')}</dt>
                    <dd className="flex items-center gap-tight">
                      <span data-testid="timeline-block">{v.anchorBlock}</span>
                      {v.chainId !== null && v.anchorBlock && explorerBlockUrl(v.chainId, BigInt(v.anchorBlock)) ? (
                        <a href={explorerBlockUrl(v.chainId, BigInt(v.anchorBlock))!} target="_blank" rel="noreferrer" className="text-sm text-content-info hover:underline">
                          {t('explorer')}
                        </a>
                      ) : null}
                    </dd>
                  </div>
                  {v.anchorTxHash ? <Hash label={t('transaction')} value={v.anchorTxHash} href={v.chainId !== null ? explorerTxUrl(v.chainId, v.anchorTxHash) : null} explorer={t('explorer')} testId="timeline-tx" /> : null}
                  <Hash label={t('recordId')} value={v.recordId} href={null} explorer={t('explorer')} testId="timeline-record" />
                  {v.copyTxHash ? <Hash label={t('copyTransaction')} value={v.copyTxHash} href={v.chainId !== null ? explorerTxUrl(v.chainId, v.copyTxHash) : null} explorer={t('explorer')} testId="timeline-copy-tx" /> : null}
                </>
              ) : (
                <div className="flex flex-col gap-tight sm:col-span-2">
                  <dt className="text-sm text-content-muted">{t('block')}</dt>
                  <dd className="text-content-muted">{t('notAnchored')}</dd>
                </div>
              )}
            </dl>
            {v.status === 'COMPLETE' || (v.status === 'REVOKED' && v.completedAt) ? (
              <div>
                <a
                  className={buttonVariants({ variant: 'secondary', size: 'sm' })}
                  href={`/api/versions/${v.id}/${v.anchorOnly ? 'certificate' : 'copy'}`}
                  data-testid={v.anchorOnly ? 'timeline-certificate' : 'timeline-copy'}
                >
                  {v.anchorOnly ? t('downloadCertificate') : t('downloadCopy')}
                </a>
              </div>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}
