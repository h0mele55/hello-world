'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Button } from '@inflect/ui/components/ui/button';
import { ConfirmDialog } from '@inflect/ui/components/ui/confirm-dialog';
import { FormField } from '@inflect/ui/components/ui/form-field';
import { Input } from '@inflect/ui/components/ui/input';
import { Textarea } from '@inflect/ui/components/ui/textarea';
import type { LocateResult } from '@/lib/opinion/locate';
import { OPINION_TYPES, type OpinionType } from '@/lib/opinion/types';
import { apiError, type ApiError } from './api-error';
import { ChoiceGroup } from './choice-group';
import { ErrorMessage } from './error-message';

/**
 * Rule 6: a person confirms the opinion. The extracted text and type are only
 * a starting point; the person reads them against the report beside this form,
 * corrects what is wrong, and confirms in a dialog that says the text becomes
 * part of the commitment. Nothing reaches CONFIRMED any other way.
 *
 * A PDF holding several auditor's reports offers each as a candidate (#77):
 * the person chooses the one this version anchors, or none and types it, and
 * the choice is recorded with the confirmation.
 */
export function ConfirmOpinionForm({ versionId, extraction }: { versionId: string; extraction: LocateResult }) {
  const t = useTranslations('confirm');
  const tTypes = useTranslations('opinion.types');
  const tNotFound = useTranslations('opinion.notFound');
  const router = useRouter();
  const found = extraction.status === 'FOUND' ? extraction : null;
  const candidates = extraction.status === 'CANDIDATES' ? extraction.candidates : [];
  const [candidate, setCandidate] = useState<string | undefined>(undefined);
  const [opinionType, setOpinionType] = useState<OpinionType | undefined>(found?.type);
  const [text, setText] = useState(found?.text ?? '');
  const [reportDate, setReportDate] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const chosen = candidate !== undefined && candidate !== 'none' ? Number(candidate.slice(1)) : undefined;
  const ready = opinionType !== undefined && text.trim() !== '' && /^\d{4}-\d{2}-\d{2}$/.test(reportDate) && (candidates.length === 0 || candidate !== undefined);

  function choose(value: string) {
    setCandidate(value);
    if (value === 'none') return;
    const passage = candidates[Number(value.slice(1))];
    setOpinionType(passage.type);
    setText(passage.text);
  }

  async function confirm() {
    setError(null);
    const response = await fetch(`/api/versions/${versionId}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ opinionType, text, reportDate, confirmed: true, ...(chosen === undefined ? {} : { candidate: chosen }) }),
    });
    if (!response.ok) {
      setError(await apiError(response));
      return;
    }
    router.refresh();
  }

  async function discard() {
    const response = await fetch(`/api/versions/${versionId}`, { method: 'DELETE' });
    if (!response.ok) {
      setError(await apiError(response));
      return;
    }
    router.push('/reports');
  }

  return (
    <div className="flex flex-col gap-default" data-testid="confirm-opinion-form">
      {found ? (
        <p className="text-content-muted" data-testid="extraction-found">
          {t('foundHint', { heading: found.heading, from: found.pageRange[0], to: found.pageRange[1] })}
        </p>
      ) : candidates.length ? (
        <>
          <p className="text-content-warning" data-testid="extraction-candidates" data-count={candidates.length}>
            {t('candidatesHint', { count: candidates.length })}
          </p>
          <ChoiceGroup<string>
            name="opinionCandidate"
            label={t('candidatesLabel')}
            value={candidate}
            onChange={choose}
            options={[
              ...candidates.map((c, i) => ({ value: `c${i}`, label: t('candidate', { n: i + 1, heading: c.heading, type: tTypes(c.type), from: c.pageRange[0], to: c.pageRange[1] }) })),
              { value: 'none', label: t('noCandidate') },
            ]}
          />
        </>
      ) : (
        <p className="text-content-warning" data-testid="extraction-not-found" data-reason={extraction.status === 'NOT_FOUND' ? extraction.reason : undefined}>
          {extraction.status === 'NOT_FOUND' ? tNotFound(extraction.reason) : null} {t('typeItIn')}
        </p>
      )}
      <ChoiceGroup<OpinionType> name="opinionType" label={t('type')} value={opinionType} onChange={setOpinionType} options={OPINION_TYPES.map((value) => ({ value, label: tTypes(value) }))} />
      <FormField label={t('text')} description={t('textDescription')} required>
        <Textarea name="opinionText" rows={14} value={text} onChange={(e) => setText(e.target.value)} data-testid="opinion-text" />
      </FormField>
      <FormField label={t('reportDate')} hint={t('reportDateHint')} required>
        <Input name="reportDate" type="date" value={reportDate} onChange={(e) => setReportDate(e.target.value)} data-testid="report-date" />
      </FormField>
      {error ? <ErrorMessage error={error} /> : null}
      <div className="flex flex-wrap gap-tight">
        <Button type="button" variant="primary" disabled={!ready} onClick={() => setConfirming(true)} data-testid="confirm-opinion">
          {t('confirmButton')}
        </Button>
        <Button type="button" variant="ghost" onClick={() => setDiscarding(true)} data-testid="discard-draft">
          {t('discardButton')}
        </Button>
      </div>
      <ConfirmDialog
        showModal={confirming}
        setShowModal={setConfirming}
        title={t('dialogTitle')}
        description={t('dialogBody')}
        tone="warning"
        confirmLabel={t('dialogConfirm')}
        onConfirm={confirm}
      />
      <ConfirmDialog
        showModal={discarding}
        setShowModal={setDiscarding}
        title={t('discardTitle')}
        description={t('discardBody')}
        tone="danger"
        confirmLabel={t('discardConfirm')}
        onConfirm={discard}
      />
    </div>
  );
}
