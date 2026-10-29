'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { StatusBadge } from '@inflect/ui/components/ui/status-badge';
import { Heading } from '@inflect/ui/components/ui/typography';
import type { SealStatus } from '@/lib/verify-core/seal';
import { utcDate } from './record-view';

const VARIANT = { SEALED: 'success', NOT_SEALED: 'neutral', NO_ROOTS: 'neutral', INVALID: 'error' } as const satisfies Record<SealStatus['status'], string>;
/** The reasons a check of a sealed file can give; anything else reads as an unreadable signature. */
const CHECK_REASONS = new Set(['NOT_WHOLE_FILE', 'MALFORMED', 'DIGEST_MISMATCH', 'BAD_SIGNATURE', 'WRONG_CERTIFICATE', 'UNTRUSTED', 'BAD_TIMESTAMP', 'CERTIFICATE_REVOKED', 'REVOCATION_REFUSED']);

const fromBase64 = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/**
 * A matched distribution copy's electronic seal (#120), checked here in the
 * browser against the roots the firm publishes. It sits beside the verdict and
 * never changes it. The check's code (pkijs) is loaded only when a copy matches.
 * A long-term seal (#119) also carries its certificates' status, checked too.
 */
export function SealView({ bytes, roots }: { bytes: Uint8Array; roots: string[] }) {
  const t = useTranslations('verify.seal');
  const [seal, setSeal] = useState<SealStatus | null>(null);

  useEffect(() => {
    // The parent keys this view by the file, so a new file starts a new view.
    let current = true;
    import('@/lib/verify-core/seal')
      .then(({ sealStatusFor }) => sealStatusFor(bytes, roots.map(fromBase64)))
      .catch((): SealStatus => ({ status: 'INVALID', reason: 'MALFORMED' }))
      .then((result) => {
        if (current) setSeal(result);
      });
    return () => {
      current = false;
    };
  }, [bytes, roots]);

  const reason = seal?.status === 'INVALID' ? (CHECK_REASONS.has(seal.reason) ? seal.reason : 'MALFORMED') : null;
  return (
    <div className="flex flex-col gap-tight" data-testid="seal" data-status={seal?.status ?? 'CHECKING'} aria-live="polite">
      <div className="flex flex-wrap items-center gap-compact">
        <Heading level={3}>{t('title')}</Heading>
        {seal ? <StatusBadge variant={VARIANT[seal.status]}>{t(`status.${seal.status}`)}</StatusBadge> : null}
      </div>
      {!seal ? <p className="text-content-muted">{t('checking')}</p> : null}
      {seal ? (
        <p className={seal.status === 'INVALID' ? 'text-content-error' : seal.status === 'SEALED' ? 'text-content-default' : 'text-content-muted'} data-testid="seal-body">
          {seal.status === 'SEALED'
            ? t('SEALED', { signer: seal.signer, when: utcDate(seal.sealedAt) })
            : reason
              ? t('INVALID', { reason: t(`reasons.${reason}`) })
              : t(seal.status)}
        </p>
      ) : null}
      {seal?.status === 'SEALED' && seal.longTerm ? (
        <p className="text-sm text-content-default" data-testid="seal-long-term">
          {t('longTerm')}
        </p>
      ) : null}
      <p className="text-sm text-content-muted">{t('apart')}</p>
    </div>
  );
}
