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
 *
 * A PDF holding several auditor's reports (an annual-report bundle, a
 * bilingual report) has several opinion headings. Picking one would be a
 * guess, so it answers CANDIDATES (#77): every one, but only when each is
 * complete on its own, with its own "Basis for …" heading before the next
 * opinion heading. The person chooses, and still confirms the text (rule 6).
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

const BASIS_PREFIXES: Record<Language, readonly string[]> = {
  en: ['basis for ', 'basis to express '],
  bg: ['база за изразяване на ', 'база за '],
};

/**
 * Wordings real reports use for the same heading, reduced to the forms in
 * HEADINGS. Each one was seen in a public report (tests/fixtures/public-corpus.json):
 * "Opinion on the financial statements" (BDO), "Our opinion is unmodified"
 * (KPMG UK), "Basis to express audit opinion" (a translation), and
 * "квалифицирано одиторско мнение".
 */
function canonicalHeading(language: Language, key: string): string {
  if (language === 'en') {
    return key
      .replace(/^our opinion is (unmodified|qualified|adverse)$/u, (_, t: string) => (t === 'unmodified' ? 'opinion' : `${t} opinion`))
      .replace(/ on the ((consolidated|group|separate|individual|stand-alone|standalone|company|parent company) )?financial statements$/u, '')
      .replace(/^(an |our )?audit opinion$/u, 'opinion');
  }
  return key.replace(/одиторско мнение$/u, 'мнение');
}

/**
 * The opinion type a "Basis for …" heading line names, or undefined when the
 * line is not one. The whole line must be the heading: running text such as
 * "…described in the" + "Basis for Qualified Opinion section of our report"
 * wraps into a line that starts like one. Bulgarian reports write both
 * "База за квалифицирано мнение" and "База за изразяване на квалифицирано
 * мнение"; the two mean the same.
 */
function basisHeadingType(language: Language, text: string): OpinionType | undefined {
  const key = headingKey(text);
  if (key === null) return undefined;
  for (const prefix of BASIS_PREFIXES[language]) {
    if (!key.startsWith(prefix)) continue;
    const type = HEADINGS[language][canonicalHeading(language, key.slice(prefix.length))];
    if (type) return type;
  }
  return undefined;
}

/** An opinion longer than this is far more likely a heading missed than a real opinion. */
export const MAX_OPINION_CHARS = 4000;
/** More opinion headings than this is not a bundle of reports a person can choose from. */
export const MAX_CANDIDATES = 10;

export type NotFoundReason =
  | 'NO_TEXT_LAYER'
  | 'NO_OPINION_HEADING'
  | 'MULTIPLE_OPINION_HEADINGS'
  | 'NO_BASIS_HEADING'
  | 'HEADING_TYPE_MISMATCH'
  | 'EMPTY_OPINION'
  | 'OPINION_TOO_LONG';

export interface OpinionPassage {
  type: OpinionType;
  language: Language;
  heading: string;
  /** Normalised (normaliser v1); ready to commit once a person confirms it. */
  text: string;
  pageRange: [number, number];
}

export type LocateResult =
  | ({ status: 'FOUND'; confidence: 'HIGH' } & OpinionPassage)
  /** Two or more reports, in the order they appear; the person chooses one. */
  | { status: 'CANDIDATES'; candidates: OpinionPassage[] }
  | { status: 'NOT_FOUND'; reason: NotFoundReason };

/** A section number before a heading: "1", "1.", "2.1", "IV.", "(a)". */
const SECTION_NUMBER = /^(\d+(\.\d+)*\.?|[IVX]+\.|\([a-z]\))\s+/u;

/** A heading starts with a capital ("Opinion", "OPINION", "Мнение"); a wrapped sentence fragment does not. */
const STARTS_UPPERCASE = /^\p{Lu}/u;

/**
 * The heading key of a line, or null when the line cannot be a heading:
 * normalised, without a section number, starting with a capital, then
 * lower-cased and without a trailing colon. A trailing full stop is NOT
 * stripped: "…a basis for our" + "opinion." wraps into a line that would
 * otherwise read as the heading.
 */
function headingKey(text: string): string | null {
  const line = normaliseText(text).replace(SECTION_NUMBER, '');
  if (!STARTS_UPPERCASE.test(line)) return null;
  return line.toLowerCase().replace(/:+$/u, '').trim();
}

function matchHeading(text: string): { language: Language; type: OpinionType } | null {
  const key = headingKey(text);
  if (key === null) return null;
  for (const language of ['en', 'bg'] as const) {
    const type = HEADINGS[language][canonicalHeading(language, key)];
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
  if (headings.length === 1) {
    const passage = passageAt(lines, headings[0], lines.length);
    return 'reason' in passage ? { status: 'NOT_FOUND', reason: passage.reason } : { status: 'FOUND', confidence: 'HIGH', ...passage };
  }

  // Several reports, or an opinion on something else. Each must be a whole
  // passage that ends before the next opinion heading begins; any doubt about
  // one, and none is offered: picking would be a guess.
  if (headings.length > MAX_CANDIDATES) return { status: 'NOT_FOUND', reason: 'MULTIPLE_OPINION_HEADINGS' };
  const candidates: OpinionPassage[] = [];
  for (const [i, heading] of headings.entries()) {
    const passage = passageAt(lines, heading, headings[i + 1]?.index ?? lines.length);
    if ('reason' in passage) return { status: 'NOT_FOUND', reason: 'MULTIPLE_OPINION_HEADINGS' };
    candidates.push(passage);
  }
  return { status: 'CANDIDATES', candidates };
}

/** The passage from an opinion heading to its "Basis for …" heading, which must come before `limit`. */
function passageAt(lines: readonly PageLine[], heading: { index: number; language: Language; type: OpinionType }, limit: number): OpinionPassage | { reason: NotFoundReason } {
  const { index: start, language, type } = heading;
  const end = lines.findIndex((line, i) => i > start && i < limit && basisHeadingType(language, line.text) !== undefined);
  if (end === -1) return { reason: 'NO_BASIS_HEADING' };

  // "Basis for Qualified Opinion" after "Adverse Opinion" means the layout
  // was not read the way the report was written.
  if (basisHeadingType(language, lines[end].text) !== type) return { reason: 'HEADING_TYPE_MISMATCH' };

  const body = lines.slice(start + 1, end).filter((line) => normaliseText(line.text) !== '');
  const text = joinLines(body.map((line) => line.text));
  if (text === '') return { reason: 'EMPTY_OPINION' };
  if (text.length > MAX_OPINION_CHARS) return { reason: 'OPINION_TOO_LONG' };

  return { type, language, heading: normaliseText(lines[start].text), text, pageRange: [lines[start].page, body[body.length - 1].page] };
}
