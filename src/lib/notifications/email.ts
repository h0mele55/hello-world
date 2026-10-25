import { createTranslator } from 'next-intl';
import type { RevocationReason } from '@/generated/prisma/enums';
import bg from '../../../messages/bg.json';
import en from '../../../messages/en.json';

/**
 * The emails a recipient gets: when a newer version supersedes the report
 * they hold, and when a version of it is revoked (#96). Plain text, no
 * attachment: each names the report and gives a link to the latest version's
 * record and to the verifier. Never the PDF, the opinion or any figure (Phase
 * 5 hardening, decision #8); a revocation's reason is the fixed label, never
 * the firm's sealed note.
 */

export const EMAIL_LOCALES = ['en', 'bg'] as const;
export type EmailLocale = (typeof EMAIL_LOCALES)[number];
const MESSAGES = { en, bg } as const;

export interface SupersededFacts {
  locale: EmailLocale;
  recipientName: string;
  firm: string;
  client: string;
  engagementRef: string;
  /** YYYY-MM-DD. */
  periodEnd: string;
  version: number;
  /** `${appUrl}/r/${familyId}/latest`. */
  latestUrl: string;
  verifyUrl: string;
}

/** A value from the database put into a line of text: no line breaks, so it can never start a header or a new paragraph. */
const oneLine = (value: string) => value.replace(/[\r\n\u2028\u2029]+/g, ' ').trim();

export interface RevokedFacts extends SupersededFacts {
  /** The revocation's reason, from the fixed list (REVOCATION_REASONS). */
  reason: RevocationReason;
}

export function supersededEmail(facts: SupersededFacts): { subject: string; text: string } {
  const t = createTranslator({ locale: facts.locale, messages: MESSAGES[facts.locale], namespace: 'email.superseded' });
  const values = {
    name: oneLine(facts.recipientName),
    firm: oneLine(facts.firm),
    client: oneLine(facts.client),
    engagementRef: oneLine(facts.engagementRef),
    periodEnd: facts.periodEnd,
    version: facts.version,
    latestUrl: facts.latestUrl,
    verifyUrl: facts.verifyUrl,
  };
  const subject = oneLine(t('subject', values));
  const text = [t('greeting', values), t('body', values), t('latest', values), t('verify', values), t('ask', values), t('noReport'), t('prototype')].join('\n\n') + '\n';
  return { subject, text };
}

export function revokedEmail(facts: RevokedFacts): { subject: string; text: string } {
  const t = createTranslator({ locale: facts.locale, messages: MESSAGES[facts.locale], namespace: 'email.revoked' });
  const reasons = createTranslator({ locale: facts.locale, messages: MESSAGES[facts.locale], namespace: 'revocation.reasons' });
  const values = {
    name: oneLine(facts.recipientName),
    firm: oneLine(facts.firm),
    client: oneLine(facts.client),
    engagementRef: oneLine(facts.engagementRef),
    periodEnd: facts.periodEnd,
    version: facts.version,
    reason: reasons(facts.reason),
    latestUrl: facts.latestUrl,
    verifyUrl: facts.verifyUrl,
  };
  const subject = oneLine(t('subject', values));
  const text = [t('greeting', values), t('body', values), t('reason', values), t('latest', values), t('verify', values), t('ask', values), t('noReport'), t('prototype')].join('\n\n') + '\n';
  return { subject, text };
}
