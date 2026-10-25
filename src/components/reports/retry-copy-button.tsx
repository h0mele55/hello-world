'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Button } from '@inflect/ui/components/ui/button';
import { ConfirmDialog } from '@inflect/ui/components/ui/confirm-dialog';
import { apiError, type ApiError } from './api-error';
import { ErrorMessage } from './error-message';

/** Queues the distribution copy again after its write failed. */
export function RetryCopyButton({ versionId }: { versionId: string }) {
  const t = useTranslations('anchoring');
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  async function retry() {
    setError(null);
    const response = await fetch(`/api/versions/${versionId}/copy/retry`, { method: 'POST' });
    if (!response.ok) {
      setError(await apiError(response));
      return;
    }
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-tight">
      <div>
        <Button type="button" variant="secondary" onClick={() => setOpen(true)} data-testid="retry-copy">
          {t('retryCopy')}
        </Button>
      </div>
      {error ? <ErrorMessage error={error} /> : null}
      <ConfirmDialog showModal={open} setShowModal={setOpen} title={t('retryTitle')} description={t('retryBody')} tone="info" confirmLabel={t('retryConfirm')} onConfirm={retry} />
    </div>
  );
}
