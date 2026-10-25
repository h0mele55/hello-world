import { getFormatter, getTranslations } from 'next-intl/server';
import { buttonVariants } from '@inflect/ui/components/ui/button-variants';
import { Card } from '@inflect/ui/components/ui/card';
import { CopyButton } from '@inflect/ui/components/ui/copy-button';
import { StatusBadge } from '@inflect/ui/components/ui/status-badge';
import { Heading } from '@inflect/ui/components/ui/typography';
import type { SessionUser } from '@/auth';
import type { OtsStatus } from '@/generated/prisma/enums';
import { getOtsProof } from '@/lib/ots/queries';

const VARIANT = { PENDING: 'info', COMPLETE: 'success', BROKEN: 'error' } as const satisfies Record<OtsStatus, string>;

/**
 * The version's second, independent timestamp (#66): its manifest hash on
 * Bitcoin through OpenTimestamps, kept by `npm run ots`. Shown once the
 * anchor is final, since only then is the manifest hash submitted.
 */
export async function OtsPanel({ user, versionId }: { user: SessionUser; versionId: string }) {
  const proof = await getOtsProof(user, versionId);
  const t = await getTranslations('ots');
  const format = await getFormatter();
  const when = (d: Date) => format.dateTime(d, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });

  return (
    <Card className="flex flex-col gap-default" data-testid="ots-panel" data-status={proof?.status ?? 'NONE'}>
      <div className="flex flex-wrap items-center gap-compact">
        <Heading level={2}>{t('title')}</Heading>
        {proof ? <StatusBadge variant={VARIANT[proof.status]}>{t(`status.${proof.status}`)}</StatusBadge> : null}
      </div>
      <p className="text-content-muted">{t('what')}</p>
      {!proof ? <p className="text-content-muted">{t('none')}</p> : null}
      {proof?.status === 'PENDING' ? (
        <p>
          {t('pending', { when: when(proof.submittedAt), count: proof.calendars.length })}
          {proof.lastError ? <span className="text-content-warning"> {t.has(`reasons.${proof.lastError}`) ? t(`reasons.${proof.lastError}`) : proof.lastError}</span> : null}
        </p>
      ) : null}
      {proof?.status === 'COMPLETE' && proof.bitcoinHeight !== null && proof.bitcoinTime && proof.bitcoinBlockHash ? (
        <>
          <p className="text-content-success" data-testid="ots-complete">
            {t('complete', { height: proof.bitcoinHeight, when: when(proof.bitcoinTime) })}
          </p>
          <div className="flex flex-col gap-tight">
            <span className="text-sm text-content-muted">{t('block')}</span>
            <div className="flex items-center gap-tight">
              <code className="break-all font-mono text-sm">{proof.bitcoinBlockHash}</code>
              <CopyButton value={proof.bitcoinBlockHash} label={t('block')} />
              <a href={`https://mempool.space/block/${proof.bitcoinBlockHash.replace(/^0x/, '')}`} target="_blank" rel="noreferrer" className="text-sm text-content-info hover:underline">
                ↗
              </a>
            </div>
          </div>
        </>
      ) : null}
      {proof?.status === 'BROKEN' ? (
        <p role="alert" className="text-content-error" data-testid="ots-broken">
          {t('broken', { reason: proof.lastError ?? '' })}
        </p>
      ) : null}
      {proof ? (
        <div>
          <a className={buttonVariants({ variant: 'secondary' })} href={`/api/versions/${versionId}/ots`} data-testid="download-ots">
            {t('download')}
          </a>
        </div>
      ) : null}
    </Card>
  );
}
