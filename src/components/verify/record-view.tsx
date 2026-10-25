'use client';

import { useTranslations } from 'next-intl';
import { CopyButton } from '@inflect/ui/components/ui/copy-button';
import { explorerBlockUrl, explorerTxUrl } from '@/lib/chain/explorer';
import type { RecordSummary } from '@/lib/verify-core';

/** Block times in UTC, written the same way in every language and on server and client alike. */
export const utcDate = (seconds: number) => `${new Date(seconds * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

export function ExplorerLink({ href, label }: { href: string | null; label: string }) {
  const t = useTranslations('verify.details');
  if (!href) return <span className="text-sm text-content-muted">({t('noExplorer')})</span>;
  return (
    <a href={href} target="_blank" rel="noreferrer" className="text-sm text-content-info hover:underline" aria-label={label}>
      ↗
    </a>
  );
}

export function HashValue({ label, value, href, testId }: { label: string; value: string; href?: string | null; testId?: string }) {
  return (
    <div className="flex flex-col gap-tight">
      <span className="text-sm text-content-muted">{label}</span>
      <div className="flex items-center gap-tight">
        <code className="break-all font-mono text-sm text-content-default" data-testid={testId}>
          {value}
        </code>
        <CopyButton value={value} label={label} />
        {href !== undefined ? <ExplorerLink href={href} label={label} /> : null}
      </div>
    </div>
  );
}

/** The issuer as a reader knows it: the name the deployment registered, or the bare id. */
export function useIssuerLabel(issuers: Record<string, string>) {
  const t = useTranslations('verify.details');
  return (orgId: string | null) => (orgId === null ? t('noIssuer') : (issuers[orgId.toLowerCase()] ?? t('unknownIssuer', { orgId })));
}

/** One registry record: its place in the family, the block and transaction that hold it, its issuer and whether it stands. */
export function RecordView({
  title,
  record,
  chainId,
  issuers,
  testId,
}: {
  title: string;
  record: RecordSummary;
  chainId: number;
  issuers: Record<string, string>;
  testId: string;
}) {
  const t = useTranslations('verify.details');
  const issuerLabel = useIssuerLabel(issuers);
  return (
    <section className="flex flex-col gap-tight" data-testid={testId} data-record-id={record.recordId}>
      <h3 className="text-sm font-medium text-content-emphasis">{title}</h3>
      <p className="text-sm text-content-default">
        <span data-testid={`${testId}-version`}>{t('version', { version: record.version })}</span> · {t(`kind.${record.kind}`)}
        {record.revoked ? <span className="text-content-error"> · {t('revokedReason', { code: record.revokeReason })}</span> : null}
      </p>
      <p className="flex items-center gap-tight text-sm text-content-default">
        <span>
          {t('block', { block: record.blockNumber })}, {utcDate(record.blockTime)}
        </span>
        <ExplorerLink href={explorerBlockUrl(chainId, record.blockNumber)} label={t('block', { block: record.blockNumber })} />
      </p>
      {record.txHash ? <HashValue label={t('transaction')} value={record.txHash} href={explorerTxUrl(chainId, record.txHash)} /> : null}
      <p className="text-sm text-content-default">
        <span className="text-content-muted">{t('issuer')}: </span>
        <span data-testid={`${testId}-issuer`}>{issuerLabel(record.orgId)}</span>
      </p>
    </section>
  );
}
