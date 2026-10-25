import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LOCALES } from '@/lib/preferences';

/**
 * The verifier's wording, held to the rules in both languages: only an
 * exact-file match may be called authentic (rule 4), every verdict that is
 * not one says the file is not the registered file, and nothing calls a
 * testnet anchor legally binding (rule 9).
 */

const ROOT = path.resolve(__dirname, '../..');
const load = (locale: string) => JSON.parse(fs.readFileSync(path.join(ROOT, 'messages', `${locale}.json`), 'utf8')) as Record<string, unknown>;

function entries(tree: unknown, prefix: string): [string, string][] {
  if (typeof tree === 'string') return [[prefix, tree]];
  return Object.entries(tree as Record<string, unknown>).flatMap(([key, value]) => entries(value, prefix ? `${prefix}.${key}` : key));
}

/** "Authentic" and "genuine" in either language. */
const AUTHENTIC = /authentic|genuine|автентич|истинск/i;
const NOT_THE_FILE = { en: 'This is not the file the issuer anchored', bg: 'Това не е файлът, който издателят е закотвил' } as const;

describe.each(LOCALES)('%s verifier wording', (locale) => {
  const messages = load(locale);
  const verifier = [...entries(messages.verify, 'verify'), ...entries(messages.latest, 'latest')];

  it('says "authentic" only for an exact-file match', () => {
    const claiming = verifier.filter(([, text]) => AUTHENTIC.test(text)).map(([key]) => key);
    expect(claiming.length).toBeGreaterThan(0);
    for (const key of claiming) expect(key).toMatch(/^verify\.verdict\.AUTHENTIC_(LATEST|SUPERSEDED)\./);
  });

  it('says plainly that an altered file is not the registered file', () => {
    for (const kind of ['ALTERED_OPINION_CHANGED', 'ALTERED_OPINION_APPEARS_UNCHANGED', 'ALTERED_OPINION_NOT_CHECKABLE']) {
      const verdict = (messages.verify as { verdict: Record<string, { body: string }> }).verdict[kind];
      expect(verdict.body.startsWith(NOT_THE_FILE[locale]), kind).toBe(true);
    }
  });

  it('never calls an anchor legally binding, anywhere in the app', () => {
    for (const [key, text] of entries(messages, '')) {
      if (/legally binding/i.test(text)) expect(text, key).toMatch(/not a legally binding/i);
      if (/правно обвързващ/i.test(text)) expect(text, key).toMatch(/не правно обвързващ|не са правно обвързващ/i);
    }
  });
});
