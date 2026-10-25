'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Button } from '@inflect/ui/components/ui/button';
import { ConfirmDialog } from '@inflect/ui/components/ui/confirm-dialog';
import type { ChainWriteMode } from '@/generated/prisma/enums';
import { MODE_LADDER, rungOf } from '@/lib/anchoring/ladder';
import { apiError, type ApiError } from './api-error';
import { ChoiceGroup } from './choice-group';
import { ErrorMessage } from './error-message';

/** The firm's write mode. Only the next rung up is offered; any rung down is. */
export function ChainModeForm({ current }: { current: ChainWriteMode }) {
  const t = useTranslations('settings');
  const router = useRouter();
  const [mode, setMode] = useState<ChainWriteMode>(current);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const reachable = MODE_LADDER.filter((m) => rungOf(m) <= rungOf(current) + 1);

  async function change() {
    setError(null);
    const response = await fetch('/api/org/chain-mode', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode }),
    });
    if (!response.ok) {
      setError(await apiError(response));
      return;
    }
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-default" data-testid="chain-mode-form">
      <ChoiceGroup<ChainWriteMode> name="chainMode" label={t('modeLabel')} value={mode} onChange={setMode} options={reachable.map((value) => ({ value, label: t(`modes.${value}`) }))} />
      {error ? <ErrorMessage error={error} /> : null}
      <div>
        <Button type="button" variant="primary" disabled={mode === current} onClick={() => setOpen(true)} data-testid="change-mode">
          {t('changeMode')}
        </Button>
      </div>
      <ConfirmDialog
        showModal={open}
        setShowModal={setOpen}
        title={t('changeTitle', { mode: t(`modes.${mode}`) })}
        description={t(`changeBody.${mode}`)}
        tone={mode === 'LIVE' ? 'warning' : 'info'}
        confirmLabel={t('changeConfirm')}
        onConfirm={change}
      />
    </div>
  );
}
