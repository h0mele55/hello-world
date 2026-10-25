'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Button } from '@inflect/ui/components/ui/button';
import { ConfirmDialog } from '@inflect/ui/components/ui/confirm-dialog';
import { apiError, type ApiError } from './api-error';
import { ErrorMessage } from './error-message';

export function RemoveRecipientButton({ recipientId, name }: { recipientId: string; name: string }) {
  const t = useTranslations('recipients');
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  async function remove() {
    setError(null);
    const response = await fetch(`/api/recipients/${recipientId}`, { method: 'DELETE' });
    if (!response.ok) {
      setError(await apiError(response));
      return;
    }
    router.refresh();
  }

  return (
    <>
      <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(true)} data-testid="remove-recipient">
        {t('remove')}
      </Button>
      {error ? <ErrorMessage error={error} /> : null}
      <ConfirmDialog
        showModal={open}
        setShowModal={setOpen}
        title={t('removeTitle', { name })}
        description={t('removeBody')}
        tone="warning"
        confirmLabel={t('removeConfirm')}
        onConfirm={remove}
      />
    </>
  );
}
