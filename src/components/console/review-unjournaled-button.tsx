'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Button } from '@inflect/ui/components/ui/button';
import { ConfirmDialog } from '@inflect/ui/components/ui/confirm-dialog';
import { apiError, type ApiError } from '@/components/reports/api-error';
import { ErrorMessage } from '@/components/reports/error-message';

/** An admin marks a write the journal did not make as reviewed (#93). */
export function ReviewUnjournaledButton({ findingId }: { findingId: string }) {
  const t = useTranslations('auditLog.watch');
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  async function review() {
    setError(null);
    const response = await fetch(`/api/registry-watch/${findingId}/review`, { method: 'POST' });
    if (!response.ok) {
      setError(await apiError(response));
      return;
    }
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-tight">
      <div>
        <Button type="button" variant="secondary" onClick={() => setOpen(true)} data-testid="review-unjournaled">
          {t('review')}
        </Button>
      </div>
      {error ? <ErrorMessage error={error} /> : null}
      <ConfirmDialog showModal={open} setShowModal={setOpen} title={t('reviewTitle')} description={t('reviewBody')} tone="info" confirmLabel={t('reviewConfirm')} onConfirm={review} />
    </div>
  );
}
