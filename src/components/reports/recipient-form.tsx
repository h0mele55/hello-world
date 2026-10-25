'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Button } from '@inflect/ui/components/ui/button';
import { FormField } from '@inflect/ui/components/ui/form-field';
import { Input } from '@inflect/ui/components/ui/input';
import { EMAIL_LOCALES, type EmailLocale } from '@/lib/notifications/email';
import { apiError, type ApiError } from './api-error';
import { ChoiceGroup } from './choice-group';
import { ErrorMessage } from './error-message';

/** Adds someone who holds a copy of the report: they are emailed when a newer version supersedes it. */
export function RecipientForm({ engagementId }: { engagementId: string }) {
  const t = useTranslations('recipients');
  const router = useRouter();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [locale, setLocale] = useState<EmailLocale>('en');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  async function add(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const response = await fetch(`/api/engagements/${engagementId}/recipients`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, locale }),
    });
    setBusy(false);
    if (!response.ok) {
      setError(await apiError(response));
      return;
    }
    setName('');
    setEmail('');
    router.refresh();
  }

  return (
    <form onSubmit={add} className="flex flex-col gap-default" data-testid="recipient-form">
      <div className="grid gap-default sm:grid-cols-2">
        <FormField label={t('name')} required>
          <Input name="recipientName" maxLength={200} value={name} onChange={(e) => setName(e.target.value)} data-testid="recipient-name" />
        </FormField>
        <FormField label={t('email')} required>
          <Input name="recipientEmail" type="email" maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} data-testid="recipient-email" />
        </FormField>
      </div>
      <ChoiceGroup<EmailLocale> name="recipientLocale" label={t('locale')} value={locale} onChange={setLocale} options={EMAIL_LOCALES.map((value) => ({ value, label: t(`locales.${value}`) }))} />
      {error ? <ErrorMessage error={error} /> : null}
      <div>
        <Button type="submit" variant="secondary" loading={busy} disabled={!name.trim() || !email.trim()} data-testid="add-recipient">
          {t('add')}
        </Button>
      </div>
    </form>
  );
}
