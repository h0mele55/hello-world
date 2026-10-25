'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Button } from '@inflect/ui/components/ui/button';
import { ConfirmDialog } from '@inflect/ui/components/ui/confirm-dialog';
import { FormField } from '@inflect/ui/components/ui/form-field';
import { Input } from '@inflect/ui/components/ui/input';
import { Textarea } from '@inflect/ui/components/ui/textarea';
import type { RevocationReason } from '@/generated/prisma/enums';
import { REVOCATION_REASONS } from '@/lib/revocation-reasons';
import { apiError, type ApiError } from './api-error';
import { ChoiceGroup } from './choice-group';
import { ErrorMessage } from './error-message';

/**
 * An admin asks for a version to be revoked: a reason, a note for the firm's
 * records, and the engagement's reference typed out, so a revocation is never
 * one stray click away. The server checks the reference too.
 */
export function RevocationForm({ versionId, version, engagementRef }: { versionId: string; version: number; engagementRef: string }) {
  const t = useTranslations('revocation');
  const router = useRouter();
  const [reason, setReason] = useState<RevocationReason | undefined>();
  const [note, setNote] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const ready = reason !== undefined && note.trim() !== '' && confirmation.trim() === engagementRef;

  async function submit() {
    setError(null);
    const response = await fetch(`/api/versions/${versionId}/revocations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason, note, confirmation }),
    });
    if (!response.ok) {
      setError(await apiError(response));
      return;
    }
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-default" data-testid="revocation-form">
      <ChoiceGroup<RevocationReason> name="revocationReason" label={t('reasonLabel')} value={reason} onChange={setReason} options={REVOCATION_REASONS.map((value) => ({ value, label: t(`reasons.${value}`) }))} />
      <FormField label={t('note')} hint={t('noteHint')} required>
        <Textarea name="revocationNote" rows={3} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} data-testid="revocation-note" />
      </FormField>
      <FormField label={t('confirmLabel', { ref: engagementRef })} required>
        <Input name="revocationConfirmation" autoComplete="off" value={confirmation} onChange={(e) => setConfirmation(e.target.value)} data-testid="revocation-confirmation" />
      </FormField>
      {error ? <ErrorMessage error={error} /> : null}
      <div>
        <Button type="button" variant="destructive" disabled={!ready} onClick={() => setOpen(true)} data-testid="request-revocation">
          {t('request', { version })}
        </Button>
      </div>
      <ConfirmDialog
        showModal={open}
        setShowModal={setOpen}
        title={t('requestTitle', { version })}
        description={t('requestBody')}
        tone="danger"
        confirmLabel={t('requestConfirm')}
        onConfirm={submit}
      />
    </div>
  );
}
