'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Button } from '@inflect/ui/components/ui/button';
import { ConfirmDialog } from '@inflect/ui/components/ui/confirm-dialog';
import { apiError, type ApiError } from './api-error';
import { ErrorMessage } from './error-message';

/** Rule 6: a second person approves the anchor, in a dialog that says what approval does. */
export function ApproveAnchorButton({ versionId, dryRun }: { versionId: string; dryRun: boolean }) {
  const t = useTranslations('anchoring');
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  async function approve() {
    setError(null);
    const response = await fetch(`/api/versions/${versionId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved: true }),
    });
    if (!response.ok) {
      setError(await apiError(response));
      return;
    }
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-tight">
      <div>
        <Button type="button" variant="primary" onClick={() => setOpen(true)} data-testid="approve-anchor">
          {dryRun ? t('approveDryRun') : t('approve')}
        </Button>
      </div>
      {error ? <ErrorMessage error={error} /> : null}
      <ConfirmDialog
        showModal={open}
        setShowModal={setOpen}
        title={t('approveTitle')}
        description={dryRun ? t('approveBodyDryRun') : t('approveBody')}
        tone="warning"
        confirmLabel={t('approveConfirm')}
        onConfirm={approve}
      />
    </div>
  );
}
