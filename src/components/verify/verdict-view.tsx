'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { StatusBadge } from '@inflect/ui/components/ui/status-badge';
import { Heading } from '@inflect/ui/components/ui/typography';
import type { RecordSummary, Verdict } from '@/lib/verify-core';
import { HashValue, RecordView, utcDate } from './record-view';

/** A verdict as the page shows it; UNEXPECTED is a failure of this page, not of the chain. */
export type ShownVerdict = Verdict | { kind: 'CANNOT_VERIFY'; reason: 'UNEXPECTED' };

const VARIANT = {
  AUTHENTIC_LATEST: 'success',
  AUTHENTIC_SUPERSEDED: 'warning',
  REVOKED: 'error',
  REVOCATION_PENDING: 'warning',
  ALTERED_OPINION_CHANGED: 'error',
  ALTERED_OPINION_APPEARS_UNCHANGED: 'warning',
  ALTERED_OPINION_NOT_CHECKABLE: 'warning',
  UNKNOWN_REGISTRY: 'neutral',
  NOT_REGISTERED: 'neutral',
  CANNOT_VERIFY: 'neutral',
} as const satisfies Record<Verdict['kind'], string>;

/**
 * What a verdict proves and what it does not (rule 4): only an exact-file
 * match is called authentic, and every record shown links to the block and
 * transaction so a reader can check it by hand. A record carried over from a
 * retired registry (#126) has no page of its own here: `retired` drops the
 * link to its family's latest, which this registry does not hold.
 */
export function VerdictView({ verdict, chainId, issuers, retired = false }: { verdict: ShownVerdict; chainId: number; issuers: Record<string, string>; retired?: boolean }) {
  const t = useTranslations('verify');
  const body = (() => {
    switch (verdict.kind) {
      case 'AUTHENTIC_SUPERSEDED':
        return t('verdict.AUTHENTIC_SUPERSEDED.body', { latest: verdict.latest.version });
      case 'REVOCATION_PENDING':
        return t('verdict.REVOCATION_PENDING.body', { when: utcDate(verdict.pending.revokeEffectiveAt) });
      case 'UNKNOWN_REGISTRY':
        return t('verdict.UNKNOWN_REGISTRY.body', { chainId: verdict.claimedChainId, contract: verdict.claimedContract });
      case 'NOT_REGISTERED':
        return t('verdict.NOT_REGISTERED.body', { note: t(`notRegistered.${verdict.note}`) });
      case 'CANNOT_VERIFY':
        return t('verdict.CANNOT_VERIFY.body', { reason: t(`cannotVerify.${verdict.reason}`) });
      default:
        return t(`verdict.${verdict.kind}.body`);
    }
  })();

  // Each record once, in the order a reader needs them.
  const records: { title: string; record: RecordSummary; testId: string }[] = [];
  const add = (title: string, record: RecordSummary, testId: string) => {
    if (!records.some((r) => r.record.recordId === record.recordId)) records.push({ title, record, testId });
  };
  if ('matched' in verdict) add(t('details.matched'), verdict.matched, 'record-matched');
  if ('claimed' in verdict) add(t('details.claimed'), verdict.claimed, 'record-claimed');
  if ('original' in verdict) add(t('details.original'), verdict.original, 'record-original');
  if ('latest' in verdict) add(t('details.latest'), verdict.latest, 'record-latest');

  return (
    <div className="flex flex-col gap-default" data-testid="verdict" data-kind={verdict.kind} aria-live="polite">
      <div className="flex flex-col gap-tight">
        <div>
          <StatusBadge variant={VARIANT[verdict.kind]}>{t(`verdict.${verdict.kind}.title`)}</StatusBadge>
        </div>
        <Heading level={2}>{t(`verdict.${verdict.kind}.title`)}</Heading>
        <p className="text-content-default" data-testid="verdict-body">
          {body}
        </p>
      </div>
      {'docHash' in verdict ? (
        <div className="flex flex-col gap-default">
          <Heading level={3}>{t('details.heading')}</Heading>
          <HashValue label={t('details.fileHash')} value={verdict.docHash} testId="file-hash" />
          {records.map(({ title, record, testId }) => (
            <RecordView key={record.recordId} title={title} record={record} chainId={chainId} issuers={issuers} testId={testId} />
          ))}
          {'latest' in verdict && !retired ? (
            <Link href={`/r/${verdict.latest.familyId}/latest`} className="text-sm text-content-info hover:underline" data-testid="latest-link">
              {t('details.latestLink')}
            </Link>
          ) : null}
          <p className="text-sm text-content-muted">{t('details.asOf', { block: verdict.asOfBlock })}</p>
        </div>
      ) : null}
    </div>
  );
}
