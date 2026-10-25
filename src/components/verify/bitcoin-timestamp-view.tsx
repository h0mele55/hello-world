'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { StatusBadge } from '@inflect/ui/components/ui/status-badge';
import { Heading } from '@inflect/ui/components/ui/typography';
import { bitcoinTimestampFor, defaultExplorers, issuerProofFetcher, type BitcoinTimestamp } from '@/lib/verify-core';
import { HashValue, utcDate } from './record-view';

const VARIANT = { CONFIRMED: 'success', PENDING: 'info', NONE: 'neutral', UNAVAILABLE: 'neutral', INVALID: 'error' } as const satisfies Record<BitcoinTimestamp['status'], string>;

/**
 * The matched report's second, independent timestamp (#66): the issuer's
 * OpenTimestamps proof of its manifest hash, asked of this site by that hash
 * and checked against Bitcoin here, in the browser. It sits beside the
 * verdict and never changes it.
 */
export function BitcoinTimestampView({ manifestHash }: { manifestHash: `0x${string}` }) {
  const t = useTranslations('verify.bitcoin');
  const [stamp, setStamp] = useState<BitcoinTimestamp | null>(null);

  useEffect(() => {
    // The parent keys this view by the manifest hash, so a new report starts a new view.
    let current = true;
    bitcoinTimestampFor(manifestHash, { fetchProof: issuerProofFetcher(window.location.origin), explorers: defaultExplorers() })
      .catch((): BitcoinTimestamp => ({ status: 'UNAVAILABLE', reason: 'ISSUER_UNREACHABLE' }))
      .then((result) => {
        if (current) setStamp(result);
      });
    return () => {
      current = false;
    };
  }, [manifestHash]);

  return (
    <div className="flex flex-col gap-tight" data-testid="bitcoin-timestamp" data-status={stamp?.status ?? 'CHECKING'} aria-live="polite">
      <div className="flex flex-wrap items-center gap-compact">
        <Heading level={3}>{t('title')}</Heading>
        {stamp ? <StatusBadge variant={VARIANT[stamp.status]}>{t(`status.${stamp.status}`)}</StatusBadge> : null}
      </div>
      {!stamp ? <p className="text-content-muted">{t('checking')}</p> : null}
      {stamp?.status === 'CONFIRMED' ? (
        <>
          <p data-testid="bitcoin-timestamp-body">{t('CONFIRMED', { when: utcDate(stamp.time), height: stamp.height })}</p>
          <HashValue label={t('block')} value={stamp.blockHash} href={`https://mempool.space/block/${stamp.blockHash.slice(2)}`} />
        </>
      ) : null}
      {stamp && stamp.status !== 'CONFIRMED' ? (
        <p className={stamp.status === 'INVALID' ? 'text-content-error' : 'text-content-muted'} data-testid="bitcoin-timestamp-body">
          {stamp.status === 'UNAVAILABLE' || stamp.status === 'INVALID' ? t(stamp.status, { reason: t(`reasons.${stamp.reason}`) }) : t(stamp.status)}
        </p>
      ) : null}
      <p className="text-sm text-content-muted">{t('apart')}</p>
    </div>
  );
}
