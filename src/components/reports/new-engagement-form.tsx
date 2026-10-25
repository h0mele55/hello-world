'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import { Button } from '@inflect/ui/components/ui/button';
import { FormField } from '@inflect/ui/components/ui/form-field';
import { Input } from '@inflect/ui/components/ui/input';
import { apiError, type ApiError } from './api-error';
import { ChoiceGroup } from './choice-group';
import { ErrorMessage } from './error-message';

type ReportType = 'STANDALONE' | 'CONSOLIDATED';

export function NewEngagementForm() {
  const t = useTranslations('engagement');
  const tTypes = useTranslations('reports.reportTypes');
  const router = useRouter();
  const [reportType, setReportType] = useState<ReportType>('STANDALONE');
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body = Object.fromEntries(['clientName', 'registrationNumber', 'country', 'engagementRef', 'periodEnd'].map((k) => [k, String(form.get(k) ?? '')]));
    setBusy(true);
    setError(null);
    const response = await fetch('/api/engagements', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, reportType }) });
    if (response.ok) {
      const { id } = (await response.json()) as { id: string };
      router.push(`/reports/${id}`);
    } else {
      setError(await apiError(response));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-default" data-testid="new-engagement-form">
      <FormField label={t('clientName')} required>
        <Input name="clientName" required maxLength={200} />
      </FormField>
      <div className="grid gap-default sm:grid-cols-[1fr_8rem]">
        <FormField label={t('registrationNumber')} hint={t('registrationNumberHint')} required>
          <Input name="registrationNumber" required maxLength={64} />
        </FormField>
        <FormField label={t('country')} hint={t('countryHint')} required>
          <Input name="country" required maxLength={2} defaultValue="BG" />
        </FormField>
      </div>
      <div className="grid gap-default sm:grid-cols-2">
        <FormField label={t('engagementRef')} hint={t('engagementRefHint')} required>
          <Input name="engagementRef" required maxLength={64} />
        </FormField>
        <FormField label={t('periodEnd')} required>
          <Input name="periodEnd" type="date" required />
        </FormField>
      </div>
      <ChoiceGroup<ReportType>
        name="reportType"
        label={t('reportType')}
        value={reportType}
        onChange={setReportType}
        options={[
          { value: 'STANDALONE', label: tTypes('STANDALONE') },
          { value: 'CONSOLIDATED', label: tTypes('CONSOLIDATED') },
        ]}
      />
      {error ? <ErrorMessage error={error} /> : null}
      <Button type="submit" variant="primary" loading={busy}>
        {t('create')}
      </Button>
    </form>
  );
}
