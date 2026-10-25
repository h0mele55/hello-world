import { describe, expect, it } from 'vitest';
import { EMAIL_LOCALES, revokedEmail, supersededEmail, type SupersededFacts } from '@/lib/notifications/email';

/**
 * The email a recipient gets when a newer version supersedes theirs (#56):
 * names and links only, in their language, and nothing from the database can
 * break out of its line.
 */

const facts = (overrides: Partial<SupersededFacts> = {}): SupersededFacts => ({
  locale: 'en',
  recipientName: 'Maria Petrova',
  firm: 'Example Audit OOD',
  client: 'Example Manufacturing AD',
  engagementRef: 'ENG-2026-001',
  periodEnd: '2025-12-31',
  version: 2,
  latestUrl: 'https://anchor.example.test/r/0xabc/latest',
  verifyUrl: 'https://anchor.example.test/verify',
  ...overrides,
});

describe('the superseded-version email', () => {
  it.each(EMAIL_LOCALES)('names the report and links the latest record and the verifier (%s)', (locale) => {
    const { subject, text } = supersededEmail(facts({ locale }));
    expect(subject).toContain('Example Audit OOD');
    expect(subject).toContain('Example Manufacturing AD');
    expect(subject).not.toMatch(/[\r\n]/);
    for (const part of ['Maria Petrova', 'ENG-2026-001', '2025-12-31', 'https://anchor.example.test/r/0xabc/latest', 'https://anchor.example.test/verify']) {
      expect(text).toContain(part);
    }
    expect(text).toMatch(locale === 'en' ? /version 2 of/ : /версия 2 на/);
    expect(text.endsWith('\n')).toBe(true);
  });

  it('is written in the recipient’s language', () => {
    expect(supersededEmail(facts({ locale: 'en' })).text).toContain('supersedes');
    const bg = supersededEmail(facts({ locale: 'bg' }));
    expect(bg.subject).toContain('нова версия');
    expect(bg.text).toContain('заменя');
  });

  it('says it carries no report, opinion or figures, and that testnet records are prototype evidence (rule 9)', () => {
    const { text } = supersededEmail(facts());
    expect(text).toContain('no report, no opinion and no figures');
    expect(text).toContain('not a legally binding record');
  });

  it('carries only what it is given: the facts hold no opinion or figure, so neither can the email', () => {
    const { subject, text } = supersededEmail(facts());
    // Every value in the message is one of the facts or the fixed wording; no
    // opinion type or amount has a way in.
    for (const word of ['UNMODIFIED', 'QUALIFIED', 'ADVERSE', 'DISCLAIMER', 'EUR', 'BGN']) {
      expect(`${subject}\n${text}`).not.toContain(word);
    }
  });

  it('keeps every value from the database on its own line, so none can start a header or a paragraph', () => {
    const hostile = 'Evil\r\nBcc: someone@example.test\u2028\n\nClick here';
    const { subject, text } = supersededEmail(facts({ recipientName: hostile, firm: hostile, client: hostile, engagementRef: hostile }));
    expect(subject).not.toMatch(/[\r\n\u2028\u2029]/);
    expect(text).not.toMatch(/\nBcc:/);
    expect(text).not.toMatch(/[\r\u2028\u2029]/);
    expect(text).toContain('Evil Bcc: someone@example.test Click here');
    // The fixed layout is seven paragraphs, whatever the values hold.
    expect(text.trimEnd().split('\n\n')).toHaveLength(7);
  });
});

describe('the revoked-version email (#96)', () => {
  const revoked = (overrides: Partial<SupersededFacts> = {}) => ({ ...facts({ version: 1, ...overrides }), reason: 'ISSUED_IN_ERROR' as const });

  it.each(EMAIL_LOCALES)('names the withdrawn version and its reason, and links the latest record and the verifier (%s)', (locale) => {
    const { subject, text } = revokedEmail(revoked({ locale }));
    expect(subject).toMatch(locale === 'en' ? /version 1 .* is withdrawn/ : /версия 1 .* е оттеглена/);
    expect(subject).not.toMatch(/[\r\n]/);
    for (const part of ['Maria Petrova', 'ENG-2026-001', '2025-12-31', 'https://anchor.example.test/r/0xabc/latest', 'https://anchor.example.test/verify']) {
      expect(text).toContain(part);
    }
    // The reason from the fixed list, in the recipient's language.
    expect(text).toContain(locale === 'en' ? 'Reason given: Issued in error.' : 'Посочена причина: Издаден по грешка.');
    expect(text).toMatch(locale === 'en' ? /Do not rely on any copy of that version/ : /Не разчитайте на нито един екземпляр/);
  });

  it('says it carries no report, opinion or figures, and keeps every value on its own line', () => {
    const hostile = 'Evil\r\nBcc: someone@example.test\u2028\n\nClick here';
    const { subject, text } = revokedEmail(revoked({ recipientName: hostile, firm: hostile, client: hostile, engagementRef: hostile }));
    expect(text).toContain('no report, no opinion and no figures');
    expect(text).toContain('not a legally binding record');
    expect(subject).not.toMatch(/[\r\n\u2028\u2029]/);
    expect(text).not.toMatch(/\nBcc:/);
    // The fixed layout is eight paragraphs: the seven of the superseded email and the reason.
    expect(text.trimEnd().split('\n\n')).toHaveLength(8);
  });
});
