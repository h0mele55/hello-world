'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Button } from '@inflect/ui/components/ui/button';
import { ConfirmDialog } from '@inflect/ui/components/ui/confirm-dialog';
import { apiError, type ApiError } from './api-error';
import { ErrorMessage } from './error-message';

type Act = 'approve' | 'reject' | 'withdraw';

/**
 * What can be done with an open request: an approver approves or rejects it
 * (rule 6: never the admin who asked, whose role cannot approve), and that
 * admin may take it back. Each act is confirmed in a dialog first.
 */
export function RevocationActions({ revocationId, acts, dryRun }: { revocationId: string; acts: Act[]; dryRun: boolean }) {
  const t = useTranslations('revocation');
  const router = useRouter();
  const [open, setOpen] = useState<Act | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  async function run(act: Act) {
    setError(null);
    const response = await fetch(`/api/revocations/${revocationId}/${act}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(act === 'approve' ? { approved: true } : {}),
    });
    if (!response.ok) {
      setError(await apiError(response));
      return;
    }
    router.refresh();
  }

  const dialog = {
    approve: { title: t('approveTitle'), body: dryRun ? t('approveBodyDryRun') : t('approveBody'), confirm: t('approveConfirm'), tone: 'danger' as const },
    reject: { title: t('rejectTitle'), body: t('rejectBody'), confirm: t('rejectConfirm'), tone: 'warning' as const },
    withdraw: { title: t('withdrawTitle'), body: t('withdrawBody'), confirm: t('withdrawConfirm'), tone: 'warning' as const },
  };
  const current = open ? dialog[open] : null;

  return (
    <div className="flex flex-col gap-tight">
      <div className="flex flex-wrap gap-tight">
        {acts.includes('approve') ? (
          <Button type="button" variant="destructive" onClick={() => setOpen('approve')} data-testid="approve-revocation">
            {dryRun ? t('approveDryRun') : t('approve')}
          </Button>
        ) : null}
        {acts.includes('reject') ? (
          <Button type="button" variant="secondary" onClick={() => setOpen('reject')} data-testid="reject-revocation">
            {t('reject')}
          </Button>
        ) : null}
        {acts.includes('withdraw') ? (
          <Button type="button" variant="secondary" onClick={() => setOpen('withdraw')} data-testid="withdraw-revocation">
            {t('withdraw')}
          </Button>
        ) : null}
      </div>
      {error ? <ErrorMessage error={error} /> : null}
      <ConfirmDialog
        showModal={open !== null}
        setShowModal={(value) => {
          if (!value) setOpen(null);
        }}
        title={current?.title ?? ''}
        description={current?.body}
        tone={current?.tone ?? 'warning'}
        confirmLabel={current?.confirm}
        onConfirm={() => (open ? run(open) : undefined)}
      />
    </div>
  );
}
