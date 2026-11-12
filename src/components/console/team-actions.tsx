'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Button } from '@inflect/ui/components/ui/button';
import { ConfirmDialog } from '@inflect/ui/components/ui/confirm-dialog';
import { apiError, type ApiError } from '@/components/reports/api-error';
import { ErrorMessage } from '@/components/reports/error-message';

/** An admin's acts on another person (#145): reset their second factor, disable or enable them. Each asks first. */
export function TeamActions({ userId, name, canReset, disabled }: { userId: string; name: string; canReset: boolean; disabled: boolean }) {
  const t = useTranslations('team');
  const router = useRouter();
  const [asking, setAsking] = useState<'reset' | 'disable' | 'enable'>('reset');
  const [open, setOpen] = useState(false);
  const ask = (which: 'reset' | 'disable' | 'enable') => {
    setAsking(which);
    setOpen(true);
  };
  const [error, setError] = useState<ApiError | null>(null);

  async function act(which: 'reset' | 'disable' | 'enable') {
    setError(null);
    const response =
      which === 'reset'
        ? await fetch(`/api/users/${userId}/mfa-reset`, { method: 'POST' })
        : await fetch(`/api/users/${userId}/disabled`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ disabled: which === 'disable' }) });
    if (!response.ok) {
      setError(await apiError(response));
      return;
    }
    router.refresh();
  }

  return (
    <div className="flex flex-wrap items-center gap-tight">
      {canReset ? (
        <Button type="button" variant="secondary" size="sm" onClick={() => ask('reset')} data-testid="reset-mfa">
          {t('reset')}
        </Button>
      ) : null}
      <Button type="button" variant="secondary" size="sm" onClick={() => ask(disabled ? 'enable' : 'disable')} data-testid={disabled ? 'enable-user' : 'disable-user'}>
        {disabled ? t('enable') : t('disable')}
      </Button>
      {error ? <ErrorMessage error={error} /> : null}
      <ConfirmDialog
        showModal={open}
        setShowModal={setOpen}
        title={t(`${asking}Title`, { name })}
        description={t(`${asking}Body`)}
        tone="warning"
        confirmLabel={t(`${asking}Confirm`)}
        onConfirm={() => act(asking)}
      />
    </div>
  );
}
