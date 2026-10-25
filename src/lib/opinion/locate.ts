import { joinLines, normaliseText, type PageLine } from './normalise';
import type { Language, OpinionType } from './types';

/**
 * Finds the auditor's opinion paragraph: the text between the one opinion
 * heading in the report and the "Basis for …" heading that follows it.
 *
 * It answers FOUND only when the match is unambiguous; anything else is
 * NOT_FOUND with a reason, and a person types or pastes the opinion instead.
 * A wrong passage presented as found would be committed permanently, so every
 * doubt is a miss (CLAUDE.md rule 7).
 */

const HEADINGS: Record<Language, Record<string, OpinionType>> = {
  en: {
    opinion: 'UNMODIFIED',
    'qualified opinion': 'QUALIFIED',
    'adverse opinion': 'ADVERSE',
    'disclaimer of opinion': 'DISCLAIMER',
  },
  bg: {
    мнение: 'UNMODIFIED',
    'квалифицирано мнение': 'QUALIFIED',
    'отрицателно мнение': 'ADVERSE',
    'отказ от изразяване на мнение': 'DISCLAIMER',
  },
};

const BASIS_PREFIX: Record<Language, string> = { en: 'basis for ', bg: 'база за ' };

/**
 * The opinion type a "Basis for …" heading line names, or undefined when the
 * line is not one. The whole line must be the heading: running text such as
 * "…described in the" + "Basis for Qualified Opinion section of our report"
 * wraps into a line that starts like one. Bulgarian reports write both
 * "База за квалифицирано мнение" and "База за изразяване на квалифицирано
 * мнение"; the two mean the same.
 */
function basisHeadingType(language: Language, text: string): OpinionType | undefined {
  if (!STARTS_UPPERCASE.test(normaliseText(text))) return undefined;
  const key = headingKey(text);
  if (!key.startsWith(BASIS_PREFIX[language])) return undefined;
  let rest = key.slice(BASIS_PREFIX[language].length);
  if (language === 'bg') rest = rest.replace(/^изразяване на /u, '');
  return HEADINGS[language][rest];
}

/** An opinion longer than this is far more likely a heading missed than a real opinion. */
export const MAX_OPINION_CHARS = 4000;

export type NotFoundReason =
  | 'NO_TEXT_LAYER'
  | 'NO_OPINION_HEADING'
  | 'MULTIPLE_OPINION_HEADINGS'
  | 'NO_BASIS_HEADING'
  | 'HEADING_TYPE_MISMATCH'
  | 'EMPTY_OPINION'
  | 'OPINION_TOO_LONG';

export type LocateResult =
  | {
      status: 'FOUND';
      type: OpinionType;
      language: Language;
      heading: string;
      /** Normalised (normaliser v1); ready to commit once a person confirms it. */
      text: string;
      pageRange: [number, number];
      confidence: 'HIGH';
    }
  | { status: 'NOT_FOUND'; reason: NotFoundReason };

/**
 * The heading key of a line: normalised, lower-cased, without a trailing
 * colon. A trailing full stop is NOT stripped: "…a basis for our" + "opinion."
 * wraps into a line that would otherwise read as the heading.
 */
function headingKey(text: string): string {
  return normaliseText(text).toLowerCase().replace(/:+$/u, '').trim();
}

/** A heading starts with a capital ("Opinion", "OPINION", "Мнение"); a wrapped sentence fragment does not. */
const STARTS_UPPERCASE = /^\p{Lu}/u;

function matchHeading(text: string): { language: Language; type: OpinionType } | null {
  if (!STARTS_UPPERCASE.test(normaliseText(text))) return null;
  const key = headingKey(text);
  for (const language of ['en', 'bg'] as const) {
    const type = HEADINGS[language][key];
    if (type) return { language, type };
  }
  return null;
}

export function locateOpinion(lines: readonly PageLine[]): LocateResult {
  if (!lines.some((line) => normaliseText(line.text) !== '')) {
    return { status: 'NOT_FOUND', reason: 'NO_TEXT_LAYER' };
  }

  const headings = lines.flatMap((line, index) => {
    const match = matchHeading(line.text);
    return match ? [{ index, ...match }] : [];
  });
  if (headings.length === 0) return { status: 'NOT_FOUND', reason: 'NO_OPINION_HEADING' };
  // Two opinion headings: a bilingual report, or an opinion on something
  // else. Picking one would be a guess.
  if (headings.length > 1) return { status: 'NOT_FOUND', reason: 'MULTIPLE_OPINION_HEADINGS' };

  const [{ index: start, language, type }] = headings;
  const end = lines.findIndex((line, i) => i > start && basisHeadingType(language, line.text) !== undefined);
  if (end === -1) return { status: 'NOT_FOUND', reason: 'NO_BASIS_HEADING' };

  // "Basis for Qualified Opinion" after "Adverse Opinion" means the layout
  // was not read the way the report was written.
  if (basisHeadingType(language, lines[end].text) !== type) return { status: 'NOT_FOUND', reason: 'HEADING_TYPE_MISMATCH' };

  const body = lines.slice(start + 1, end).filter((line) => normaliseText(line.text) !== '');
  const text = joinLines(body.map((line) => line.text));
  if (text === '') return { status: 'NOT_FOUND', reason: 'EMPTY_OPINION' };
  if (text.length > MAX_OPINION_CHARS) return { status: 'NOT_FOUND', reason: 'OPINION_TOO_LONG' };

  return {
    status: 'FOUND',
    type,
    language,
    heading: normaliseText(lines[start].text),
    text,
    pageRange: [lines[start].page, body[body.length - 1].page],
    confidence: 'HIGH',
  };
}
