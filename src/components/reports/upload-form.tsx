'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import { Button } from '@inflect/ui/components/ui/button';
import { FormField } from '@inflect/ui/components/ui/form-field';
import { apiError, type ApiError } from './api-error';
import { ChoiceGroup } from './choice-group';
import { ErrorMessage } from './error-message';

const REISSUE_REASONS = ['CORRECTION', 'SUBSEQUENT_EVENT', 'OTHER'] as const;
type ReissueReason = (typeof REISSUE_REASONS)[number];

/** Uploads one PDF as the next version. Version 1 needs no reason; a reissue does. */
export function UploadForm({ engagementId, nextVersion }: { engagementId: string; nextVersion: number }) {
  const t = useTranslations('upload');
  const router = useRouter();
  const [reason, setReason] = useState<ReissueReason | undefined>(undefined);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const isReissue = nextVersion > 1;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const file = new FormData(event.currentTarget).get('file');
    if (!(file instanceof File) || file.size === 0) return;
    if (isReissue && !reason) {
      setError({ error: 'INVALID_INPUT' });
      return;
    }
    setBusy(true);
    setError(null);
    const response = await fetch(`/api/engagements/${engagementId}/versions?reason=${isReissue ? reason : 'INITIAL'}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/pdf' },
      body: file,
    });
    if (response.ok) {
      const { id } = (await response.json()) as { id: string };
      router.push(`/reports/versions/${id}`);
    } else {
      setError(await apiError(response));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-default" data-testid="upload-form">
      <FormField label={t('file', { version: nextVersion })} hint={t('fileHint')} required>
        <input name="file" type="file" accept="application/pdf,.pdf" required className="text-content-default" data-testid="upload-file" />
      </FormField>
      {isReissue ? (
        <ChoiceGroup<ReissueReason> name="reason" label={t('reason')} value={reason} onChange={setReason} options={REISSUE_REASONS.map((value) => ({ value, label: t(`reasons.${value}`) }))} />
      ) : null}
      {error ? <ErrorMessage error={error} /> : null}
      <Button type="submit" variant="primary" loading={busy}>
        {t('submit')}
      </Button>
    </form>
  );
}
