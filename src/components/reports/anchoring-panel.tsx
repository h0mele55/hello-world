import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import { buttonVariants } from '@inflect/ui/components/ui/button-variants';
import { Card } from '@inflect/ui/components/ui/card';
import { CopyButton } from '@inflect/ui/components/ui/copy-button';
import { StatusBadge } from '@inflect/ui/components/ui/status-badge';
import { Heading } from '@inflect/ui/components/ui/typography';
import type { SessionUser } from '@/auth';
import type { ChainWriteStatus, VersionStatus } from '@/generated/prisma/enums';
import { getVersionAnchoring, resolveAnchorTarget } from '@/lib/anchoring/queries';
import { explorerTxUrl } from '@/lib/chain/explorer';
import { ApproveAnchorButton } from './approve-anchor-button';
import { RetryCopyButton } from './retry-copy-button';
import { mayDo } from '@/lib/roles';

const WRITE_VARIANT = {
  INTENT: 'neutral',
  SIMULATED: 'info',
  BROADCAST: 'info',
  FINAL: 'success',
  FAILED: 'error',
  INDETERMINATE: 'warning',
} as const satisfies Record<ChainWriteStatus, string>;

function Value({ label, value, href, testId }: { label: string; value: string; href?: string | null; testId?: string }) {
  return (
    <div className="flex flex-col gap-tight">
      <span className="text-sm text-content-muted">{label}</span>
      <div className="flex items-center gap-tight">
        <code className="break-all font-mono text-sm text-content-default" data-testid={testId}>
          {value}
        </code>
        <CopyButton value={value} label={label} />
        {href ? (
          <a href={href} target="_blank" rel="noreferrer" className="text-sm text-content-info hover:underline">
            ↗
          </a>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Where a version stands on chain: the approval a second person gives (rule
 * 6), and every journal row the worker has written for it. "Final" appears
 * only once the record's block is finalized (rule 2).
 */
export async function AnchoringPanel({ user, versionId, status }: { user: SessionUser; versionId: string; status: VersionStatus }) {
  const anchoring = await getVersionAnchoring(user, versionId);
  const { target, problem } = resolveAnchorTarget();
  const t = await getTranslations('anchoring');
  const format = await getFormatter();
  const chainId = target?.chainId ?? anchoring.writes[0]?.chainId ?? 0;

  function reason(code: string) {
    // A stamp that did not pass its check is one sentence, with the check's own code beside it.
    if (code.startsWith('STAMP_')) return t('reasons.STAMP_CHECK');
    const [name, detail] = code.split(':');
    const key = `reasons.${name}` as const;
    return t.has(key) ? `${t(key)}${detail ? ` (${detail})` : ''}` : null;
  }
  const copyWrites = anchoring.writes.filter((w) => w.kind === 'ANCHOR_COPY');
  // A version revoked after it was complete keeps its copy or certificate, for the firm's records.
  const distributable = status === 'COMPLETE' || (status === 'REVOKED' && (anchoring.anchorOnly ? anchoring.hasCertificate : anchoring.copyRecordId !== null));
  const copyNeedsRetry = status === 'ANCHORED' && !anchoring.anchorOnly && copyWrites.length > 0 && copyWrites.every((w) => w.status === 'FAILED');

  return (
    <Card className="flex flex-col gap-default" data-testid="anchoring-panel">
      <Heading level={2}>{t('title')}</Heading>
      <p className="text-content-muted">{t('prototypeEvidence')}</p>

      {distributable ? (
        <div className="flex flex-col gap-default" data-testid="complete">
          {status === 'COMPLETE' ? <p className="text-content-success">{anchoring.anchorOnly ? t('completeCertificate') : t('completeCopy')}</p> : null}
          <div>
            <a
              className={buttonVariants({ variant: 'primary' })}
              href={`/api/versions/${versionId}/${anchoring.anchorOnly ? 'certificate' : 'copy'}`}
              data-testid={anchoring.anchorOnly ? 'download-certificate' : 'download-copy'}
            >
              {anchoring.anchorOnly ? t('downloadCertificate') : t('downloadCopy')}
            </a>
          </div>
          {anchoring.copyRecordId ? <Value label={t('copyRecordId')} value={anchoring.copyRecordId} testId="copy-record-id" /> : null}
          {anchoring.copyTxHash ? <Value label={t('copyTxHash')} value={anchoring.copyTxHash} href={explorerTxUrl(chainId, anchoring.copyTxHash)} /> : null}
        </div>
      ) : null}
      {status === 'ANCHORED' ? (
        <p className="text-content-muted" data-testid="copy-pending">
          {anchoring.anchorOnly ? t('certificatePending') : copyNeedsRetry ? t('copyFailed') : t('copyPending')}
        </p>
      ) : null}
      {copyNeedsRetry && mayDo(user.role, 'approve') ? <RetryCopyButton versionId={versionId} /> : null}

      {(status === 'ANCHORED' || status === 'COMPLETE' || status === 'REVOKED') && anchoring.recordId ? (
        <div className="flex flex-col gap-default" data-testid="anchored">
          <p className="text-content-success">{t('anchored', { block: anchoring.anchorBlock ?? '' })}</p>
          <Value label={t('recordId')} value={anchoring.recordId} testId="anchor-record-id" />
          {anchoring.anchorTxHash ? <Value label={t('txHash')} value={anchoring.anchorTxHash} href={explorerTxUrl(chainId, anchoring.anchorTxHash)} /> : null}
          <p>
            <span className="text-content-muted">{t('block')}: </span>
            <span data-testid="anchor-block">{anchoring.anchorBlock}</span>
          </p>
        </div>
      ) : null}

      {status === 'CONFIRMED' && mayDo(user.role, 'approve') ? (
        !target ? (
          <p className="text-content-warning" data-testid="anchoring-not-configured">
            {t('notConfigured')} <span className="text-content-muted">({problem})</span>
          </p>
        ) : anchoring.mode === 'DISABLED' ? (
          <p className="text-content-warning" data-testid="anchoring-disabled">
            {t('disabled')}{' '}
            <Link href="/reports/settings" className="underline">
              {t('settingsLink')}
            </Link>
          </p>
        ) : (
          <>
            <p className="text-content-muted">{anchoring.mode === 'DRY_RUN' ? t('dryRunHint') : t('liveHint')}</p>
            <ApproveAnchorButton versionId={versionId} dryRun={anchoring.mode === 'DRY_RUN'} />
          </>
        )
      ) : null}
      {status === 'CONFIRMED' && mayDo(user.role, 'prepare') ? <p className="text-content-muted">{t('waitingApprover')}</p> : null}
      {status === 'APPROVED' ? (
        <p className="text-content-muted" data-testid="anchor-queued">
          {t('queued', { approver: anchoring.approvedBy ?? '' })}
        </p>
      ) : null}

      <Heading level={3}>{t('journal')}</Heading>
      {anchoring.writes.length === 0 ? (
        <p className="text-content-muted">{t('noWrites')}</p>
      ) : (
        <ol className="flex flex-col gap-default" data-testid="chain-writes">
          {anchoring.writes.map((write) => (
            <li key={write.id} className="flex flex-col gap-tight border-l-2 border-border-subtle pl-default" data-testid="chain-write" data-status={write.status} data-kind={write.kind}>
              <div className="flex flex-wrap items-center gap-tight">
                <StatusBadge variant={WRITE_VARIANT[write.status]}>{t(`status.${write.status}`)}</StatusBadge>
                <StatusBadge variant="neutral">{t(`kinds.${write.kind}`)}</StatusBadge>
                <StatusBadge variant="neutral">{t(`modes.${write.mode}`)}</StatusBadge>
                <span className="text-sm text-content-muted">{format.dateTime(write.createdAt, { dateStyle: 'medium', timeStyle: 'short' })}</span>
              </div>
              {write.error ? (
                <p className="text-sm" data-testid="chain-write-reason" data-code={write.error}>
                  {reason(write.error) ?? t('reasonUnknown')} <code className="text-content-muted">{write.error}</code>
                </p>
              ) : write.status === 'SIMULATED' ? (
                <p className="text-sm" data-testid="chain-write-reason">
                  {t('wouldSucceed')}
                </p>
              ) : null}
              {write.txHash ? <Value label={t('txHash')} value={write.txHash} href={explorerTxUrl(write.chainId, write.txHash)} /> : null}
              {write.replacedTxHashes.length > 0 ? <p className="text-sm text-content-muted">{t('replaced', { count: write.replacedTxHashes.length })}</p> : null}
              <p className="text-sm text-content-muted">
                {write.nonce !== null ? `${t('nonce')}: ${write.nonce}` : null}
                {write.nonce !== null && write.blockNumber ? ' · ' : null}
                {write.blockNumber ? `${t('block')}: ${write.blockNumber}` : null}
              </p>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
