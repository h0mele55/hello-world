'use client';

import { useTranslations } from 'next-intl';
import { Heading } from '@inflect/ui/components/ui/typography';
import { explorerAddressUrl, networkNameOf } from '@/lib/chain/explorer';
import type { Reanchored } from '@/lib/verify-core';
import { HashValue } from './record-view';

/**
 * Where a re-anchored record's verdict comes from (#126): the retired registry
 * it was on and the block its records were read at, and the root on this
 * registry that vouches for all of them. A browser verifier is given
 * re-anchor archives only, so a checkpoint, which the CLI alone reads, is not
 * shown here.
 */
export function ReanchoredView({ reanchored }: { reanchored: Reanchored }) {
  const t = useTranslations('verify.reanchored');
  if (reanchored.kind !== 'registry') return null;
  return (
    <div className="flex flex-col gap-tight" data-testid="reanchored" data-index={reanchored.index}>
      <Heading level={3}>{t('title')}</Heading>
      <p className="text-content-default" data-testid="reanchored-body">
        {t('body', {
          registry: reanchored.sourceRegistry,
          network: networkNameOf(reanchored.sourceChainId),
          block: reanchored.sourceBlock,
          count: reanchored.count,
          index: reanchored.index,
          recordedBlock: reanchored.recordedBlock,
        })}
      </p>
      <HashValue label={t('sourceRegistry')} value={reanchored.sourceRegistry} href={explorerAddressUrl(reanchored.sourceChainId, reanchored.sourceRegistry)} />
      <p className="text-sm text-content-muted">{t('frozen')}</p>
    </div>
  );
}
