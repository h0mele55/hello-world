import { createTranslator } from 'next-intl';
import bg from '../../../messages/bg.json';
import en from '../../../messages/en.json';

/**
 * The email a recipient gets when a newer version supersedes the report they
 * hold. Plain text, no attachment: it names the report and gives a link to
 * the latest version's record and to the verifier. Never the PDF, the opinion
 * or any figure (Phase 5 hardening, decision #8).
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
