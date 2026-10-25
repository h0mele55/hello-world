import { describe, expect, it } from 'vitest';
import { locateOpinion, MAX_CANDIDATES, MAX_OPINION_CHARS } from '@/lib/opinion/locate';
import { dropRunningLines, joinLines, normaliseText, type PageLine } from '@/lib/opinion/normalise';

const ch = (code: number) => String.fromCharCode(code);
const SOFT_HYPHEN = ch(0xad);
const ZWSP = ch(0x200b);
const UNICODE_HYPHEN = ch(0x2010);

/** One page of lines, numbered from 1. */
const page = (...texts: string[]): PageLine[] => texts.map((text) => ({ page: 1, text }));

describe('normaliseText (normaliser v1)', () => {
  it('applies NFKC, drops invisible and control characters, and collapses whitespace', () => {
    expect(normaliseText(`  ﬁnancial${ZWSP}  state${SOFT_HYPHEN}ments\t\n present ${ch(0x7)}fairly `)).toBe('financial statements present fairly');
    expect(normaliseText(`a${ch(0xa0)}b`)).toBe('a b');
  });

  it('is idempotent', () => {
    for (const s of [' Мнение \n', `x${SOFT_HYPHEN}y`, '①  ②', `a${ch(0xd800)}b`]) {
      expect(normaliseText(normaliseText(s))).toBe(normaliseText(s));
    }
  });

  it('replaces a lone surrogate visibly rather than letting it vanish in UTF-8', () => {
    expect(normaliseText(`a${ch(0xd800)}b`)).toBe(`a${ch(0xfffd)}b`);
  });
});

describe('joinLines', () => {
  it('re-joins a word hyphenated across lines, in Latin and Cyrillic', () => {
    expect(joinLines(['the financial state-', 'ments present'])).toBe('the financial statements present');
    expect(joinLines(['финансов отч-', 'ет'])).toBe('финансов отчет');
    expect(joinLines([`state${UNICODE_HYPHEN}`, 'ments'])).toBe('statements');
    expect(joinLines([`state${SOFT_HYPHEN}`, 'Ments'])).toBe('stateMents');
  });

  it('keeps a hyphen that is part of the text, with no space added', () => {
    expect(joinLines(['Anglo-', 'American'])).toBe('Anglo-American');
    expect(joinLines(['2024-', '2025'])).toBe('2024-2025');
  });

  it('treats a spaced dash as a word boundary', () => {
    expect(joinLines(['item 3 -', 'note'])).toBe('item 3 - note');
  });

  it('turns every other line break into one space and skips blank lines', () => {
    expect(joinLines(['In our opinion,', '', '  the accompanying  ', 'statements'])).toBe('In our opinion, the accompanying statements');
  });
});

describe('dropRunningLines', () => {
  const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'];
  const body = (n: number) => WORDS.slice(0, 7).map((w) => `${w} text on page ${WORDS[n]}`);

  it('drops headers and footers repeated at page edges, page numbers included', () => {
    const pages = [1, 2, 3, 4].map((n) => ['Example AD', `Independent auditor's report`, ...body(n), `Page ${n} of 4`]);
    const kept = dropRunningLines(pages).map((l) => l.text);
    expect(kept).not.toContain('Example AD');
    expect(kept.some((t) => t.startsWith('Page'))).toBe(false);
    expect(kept).toContain('alpha text on page bravo');
    expect(kept).toHaveLength(4 * 7);
  });

  it('keeps everything in a one-page document, and keeps a repeated line away from the edges', () => {
    expect(dropRunningLines([['Opinion', 'x', 'Page 1 of 1']])).toHaveLength(3);
    const pages = [1, 2].map((n) => [`h${n}a`, `h${n}b`, `h${n}c`, 'Repeated in the middle', `f${n}a`, `f${n}b`, `f${n}c`]);
    expect(dropRunningLines(pages).filter((l) => l.text === 'Repeated in the middle')).toHaveLength(2);
  });

  it('matches by slot: a header line moved into the body is kept', () => {
    const pages = [1, 2, 3].map((n) => ['Example AD', ...body(n), `${n}`]);
    pages[2] = [...body(3).slice(0, 4), 'Example AD', ...body(3).slice(4), '3'];
    const kept = dropRunningLines(pages);
    expect(kept.filter((l) => l.text === 'Example AD').map((l) => l.page)).toEqual([3]);
    expect(kept.some((l) => /^\d$/.test(l.text))).toBe(false);
  });

  it('numbers pages from 1', () => {
    expect(dropRunningLines([['a'], ['b']]).map((l) => l.page)).toEqual([1, 2]);
  });
});

describe('locateOpinion', () => {
  const opinion = ['We have audited the financial statements of Example AD.', 'In our opinion, the accompanying financial statements present fairly,', 'in all material respects, the financial position of the Company.'];

  it('finds an English unmodified opinion between its heading and "Basis for Opinion"', () => {
    const result = locateOpinion(page("Independent Auditor's Report", 'Opinion', ...opinion, 'Basis for Opinion', 'We conducted our audit…'));
    expect(result).toEqual({
      status: 'FOUND',
      type: 'UNMODIFIED',
      language: 'en',
      heading: 'Opinion',
      text: joinLines(opinion),
      pageRange: [1, 1],
      confidence: 'HIGH',
    });
  });

  it('recognises every English and Bulgarian heading, in any case and with a trailing colon', () => {
    const cases: [string, string, string][] = [
      ['QUALIFIED OPINION', 'Basis for Qualified Opinion', 'QUALIFIED'],
      ['Adverse Opinion:', 'Basis for Adverse Opinion', 'ADVERSE'],
      ['Disclaimer of Opinion', 'Basis for Disclaimer of Opinion', 'DISCLAIMER'],
      ['Мнение', 'База за мнение', 'UNMODIFIED'],
      ['Квалифицирано мнение', 'База за квалифицирано мнение', 'QUALIFIED'],
      ['ОТРИЦАТЕЛНО МНЕНИЕ', 'База за отрицателно мнение', 'ADVERSE'],
      ['Отказ от изразяване на мнение', 'База за отказ от изразяване на мнение', 'DISCLAIMER'],
      ['Мнение', 'База за изразяване на мнение', 'UNMODIFIED'],
      ['Квалифицирано мнение', 'База за изразяване на квалифицирано мнение', 'QUALIFIED'],
    ];
    for (const [heading, basis, type] of cases) {
      const result = locateOpinion(page(heading, 'Текст на мнението.', basis));
      expect(result, heading).toMatchObject({ status: 'FOUND', type });
    }
  });

  it('reads the wordings real reports use (tests/fixtures/public-corpus.json)', () => {
    const cases: [string, string, string][] = [
      ['Opinion on the financial statements', 'Basis for opinion', 'UNMODIFIED'],
      ['Qualified opinion on the consolidated financial statements', 'Basis for qualified opinion', 'QUALIFIED'],
      ['1 Our opinion is unmodified', 'Basis for opinion', 'UNMODIFIED'],
      ['2. Our opinion is qualified', 'Basis for qualified opinion', 'QUALIFIED'],
      ['Opinion', 'Basis to express audit opinion', 'UNMODIFIED'],
      ['Квалифицирано одиторско мнение', 'База за изразяване на квалифицирано одиторско мнение', 'QUALIFIED'],
      ['Одиторско мнение', 'База за изразяване на одиторско мнение', 'UNMODIFIED'],
    ];
    for (const [heading, basis, type] of cases) {
      expect(locateOpinion(page(heading, 'Text of the opinion.', basis)), heading).toMatchObject({ status: 'FOUND', type });
    }
  });

  it('still refuses near misses of those wordings', () => {
    // A heading for something other than the financial statements, a
    // misspelled heading, and a numbered line that is running text.
    expect(locateOpinion(page('Opinion on regularity', 'x.', 'Basis for opinion'))).toEqual({ status: 'NOT_FOUND', reason: 'NO_OPINION_HEADING' });
    expect(locateOpinion(page('Квалифицирно одиторско мнение', 'x.', 'База за изразяване на квалифицирано одиторско мнение'))).toEqual({ status: 'NOT_FOUND', reason: 'NO_OPINION_HEADING' });
    expect(locateOpinion(page('1 our opinion is unmodified', 'x.', 'Basis for opinion'))).toEqual({ status: 'NOT_FOUND', reason: 'NO_OPINION_HEADING' });
    expect(locateOpinion(page('Opinion', 'x.', 'Basis to express our views'))).toEqual({ status: 'NOT_FOUND', reason: 'NO_BASIS_HEADING' });
  });

  it('spans pages and reports the range', () => {
    const lines: PageLine[] = [
      { page: 2, text: 'Opinion' },
      { page: 2, text: 'First half,' },
      { page: 3, text: 'second half.' },
      { page: 3, text: 'Basis for Opinion' },
    ];
    expect(locateOpinion(lines)).toMatchObject({ text: 'First half, second half.', pageRange: [2, 3] });
  });

  it('does not take a wrapped "opinion." or a lower-case fragment for the heading', () => {
    const lines = page('Basis for Opinion', 'We believe the evidence is sufficient to provide a basis for our', 'opinion.', 'opinion', 'Other information');
    expect(locateOpinion(lines)).toEqual({ status: 'NOT_FOUND', reason: 'NO_OPINION_HEADING' });
  });

  it('answers NOT_FOUND, with a reason, whenever it would have to guess', () => {
    const cases: [PageLine[], string][] = [
      [[], 'NO_TEXT_LAYER'],
      [page('  ', ''), 'NO_TEXT_LAYER'],
      [page('Report', 'Some text'), 'NO_OPINION_HEADING'],
      // Two opinion headings, one of them incomplete: neither is offered (#77).
      [page('Opinion', 'x', 'Basis for Opinion', 'Мнение', 'y'), 'MULTIPLE_OPINION_HEADINGS'],
      [page('Opinion', 'x', 'Other matter'), 'NO_BASIS_HEADING'],
      [page('Мнение', 'x', 'Basis for Opinion'), 'NO_BASIS_HEADING'],
      [page('Qualified Opinion', 'x', 'Basis for Adverse Opinion'), 'HEADING_TYPE_MISMATCH'],
      [page('Мнение', 'x', 'База за изразяване на отрицателно мнение'), 'HEADING_TYPE_MISMATCH'],
      [page('Opinion', '   ', 'Basis for Opinion'), 'EMPTY_OPINION'],
      [page('Opinion', 'x'.repeat(MAX_OPINION_CHARS + 1), 'Basis for Opinion'), 'OPINION_TOO_LONG'],
    ];
    for (const [lines, reason] of cases) {
      expect(locateOpinion(lines), reason).toEqual({ status: 'NOT_FOUND', reason });
    }
  });

  it('does not stop at running text that wraps to start with "Basis for"', () => {
    const lines = page('Qualified Opinion', 'In our opinion, except for the matter described in the', 'Basis for Qualified Opinion section of our report, the statements', 'present fairly.', 'Basis for Qualified Opinion');
    expect(locateOpinion(lines)).toMatchObject({
      status: 'FOUND',
      text: 'In our opinion, except for the matter described in the Basis for Qualified Opinion section of our report, the statements present fairly.',
    });
  });

  it('takes only a whole-line basis heading that names an opinion type', () => {
    expect(locateOpinion(page('Opinion', 'x.', 'Basis for opinion and emphasis'))).toEqual({ status: 'NOT_FOUND', reason: 'NO_BASIS_HEADING' });
    expect(locateOpinion(page('Opinion', 'x.', 'Basis For Opinion:'))).toMatchObject({ status: 'FOUND', text: 'x.' });
  });

  describe('a PDF holding several reports (#77)', () => {
    it('offers every report, in order, when each is a whole passage of its own', () => {
      const lines: PageLine[] = [
        { page: 3, text: 'Disclaimer of Opinion' },
        { page: 3, text: 'We do not express an opinion on the council’s statements.' },
        { page: 3, text: 'Basis for Disclaimer of Opinion' },
        { page: 4, text: 'We were unable to obtain evidence.' },
        { page: 116, text: 'Opinion on the financial statements' },
        { page: 116, text: 'In our opinion, the pension fund’s statements' },
        { page: 117, text: 'present fairly.' },
        { page: 117, text: 'Basis for Opinion' },
      ];
      expect(locateOpinion(lines)).toEqual({
        status: 'CANDIDATES',
        candidates: [
          { type: 'DISCLAIMER', language: 'en', heading: 'Disclaimer of Opinion', text: 'We do not express an opinion on the council’s statements.', pageRange: [3, 3] },
          { type: 'UNMODIFIED', language: 'en', heading: 'Opinion on the financial statements', text: 'In our opinion, the pension fund’s statements present fairly.', pageRange: [116, 117] },
        ],
      });
    });

    it('offers both languages of a bilingual report, for the person to choose', () => {
      expect(locateOpinion(page('Opinion', 'x', 'Basis for Opinion', 'Мнение', 'y', 'База за мнение'))).toMatchObject({
        status: 'CANDIDATES',
        candidates: [
          { language: 'en', text: 'x' },
          { language: 'bg', text: 'y' },
        ],
      });
    });

    it('offers none when one passage would run into the next report, or does not end as it began', () => {
      // The first report's basis heading comes only after the second report's opinion heading.
      expect(locateOpinion(page('Opinion', 'x', 'Qualified Opinion', 'y', 'Basis for Opinion', 'Basis for Qualified Opinion'))).toEqual({
        status: 'NOT_FOUND',
        reason: 'MULTIPLE_OPINION_HEADINGS',
      });
      expect(locateOpinion(page('Opinion', 'x', 'Basis for Opinion', 'Adverse Opinion', 'y', 'Basis for Qualified Opinion'))).toEqual({
        status: 'NOT_FOUND',
        reason: 'MULTIPLE_OPINION_HEADINGS',
      });
      expect(locateOpinion(page('Opinion', ' ', 'Basis for Opinion', 'Opinion', 'y', 'Basis for Opinion'))).toEqual({ status: 'NOT_FOUND', reason: 'MULTIPLE_OPINION_HEADINGS' });
    });

    it(`offers none past ${MAX_CANDIDATES} reports`, () => {
      const report = (n: number) => ['Opinion', `report ${n}`, 'Basis for Opinion'];
      const many = (count: number) => page(...Array.from({ length: count }, (_, i) => report(i + 1)).flat());
      expect(locateOpinion(many(MAX_CANDIDATES))).toMatchObject({ status: 'CANDIDATES' });
      expect(locateOpinion(many(MAX_CANDIDATES + 1))).toEqual({ status: 'NOT_FOUND', reason: 'MULTIPLE_OPINION_HEADINGS' });
    });
  });
});
