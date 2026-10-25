'use client';

import { useTranslations } from 'next-intl';
import type { ApiError } from './api-error';

const KNOWN_ERRORS = new Set([
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'CROSS_ORIGIN',
  'NOT_FOUND',
  'INVALID_INPUT',
  'TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'PDF_REFUSED',
  'DOC_ALREADY_UPLOADED',
  'ENGAGEMENT_EXISTS',
  'DRAFT_PENDING',
  'VERSION_CONFLICT',
  'NOT_DRAFT',
  'NOT_CONFIRMED',
  'FOUR_EYES',
  'CHAIN_WRITES_DISABLED',
  'CHAIN_NOT_CONFIGURED',
  'PREDECESSOR_NOT_ANCHORED',
  'ALREADY_QUEUED',
  'MODE_UNCHANGED',
  'MODE_SKIPS_RUNG',
  'INTERNAL',
]);
const KNOWN_REFUSALS = new Set(['NOT_A_PDF', 'TRUNCATED', 'TOO_LARGE', 'TOO_MANY_PAGES', 'TOO_MUCH_TEXT', 'ENCRYPTED', 'UNPARSEABLE', 'TIMEOUT', 'RESOURCE_LIMIT', 'PARSER_CRASHED']);

/** Says what went wrong in words, with the code beside it for support. */
export function ErrorMessage({ error }: { error: ApiError }) {
  const t = useTranslations('errors');
  const code = KNOWN_ERRORS.has(error.error) ? error.error : 'INTERNAL';
  const refusal = code === 'PDF_REFUSED' && error.detail && KNOWN_REFUSALS.has(error.detail) ? error.detail : null;
  return (
    <p role="alert" className="text-content-error" data-testid="error-message" data-code={refusal ?? code}>
      {refusal ? t(`refusals.${refusal}`) : t(code)} <span className="text-content-muted">({refusal ?? code})</span>
    </p>
  );
}
