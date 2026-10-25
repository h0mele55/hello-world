/**
 * Normaliser v1. Its version is written into every manifest (`norm: 1`), and a
 * reader refuses a version it does not know: changing any step below changes
 * what a stored commitment means, so it is a new version, never an edit.
 *
 * Two layers:
 * - `normaliseText` works on characters and is idempotent. The opinion
 *   commitment is taken over its output.
 * - `joinLines` and `dropRunningLines` work on the line layout a parser
 *   extracted, before `normaliseText` runs.
 */
export const NORMALISER_VERSION = 1;

// Soft hyphen, zero-width space/joiners, word joiner, byte-order mark.
const INVISIBLE = /[\u00AD\u200B-\u200D\u2060\uFEFF]/g;
// C0 and C1 controls except the whitespace ones, which collapse below.
const CONTROL = /[\u0000-\u0008\u000E-\u001F\u007F-\u009F]/g;

export function normaliseText(text: string): string {
  return text
    // A lone surrogate would become U+FFFD when hashed as UTF-8, so two
    // different strings could commit alike; replace it here, visibly.
    .toWellFormed()
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    .replace(CONTROL, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

// A hyphen at a line end right after a non-space character: ASCII
// hyphen-minus, Unicode hyphen or non-breaking hyphen.
const LINE_END_HYPHEN = /(\S)[-\u2010\u2011]$/u;
const LETTER = /\p{L}/u;
const STARTS_LOWERCASE = /^\p{Ll}/u;

/**
 * Joins extracted lines into running text.
 * - A soft hyphen at a line end always marks a broken word: it is dropped.
 * - A letter, a hyphen, then a line starting in lower case is one word broken
 *   across the line ("финан-" + "сов" → "финансов"): the hyphen is dropped.
 * - Any other hyphen after a non-space character is part of the text
 *   ("Anglo-" + "American", "2024-" + "2025"): it stays, with no space added.
 * - Every other boundary becomes one space.
 * Deterministic rather than clever: "well-" + "known" becomes "wellknown". A
 * person confirms the text, and every reader applies the same rule.
 */
export function joinLines(lines: readonly string[]): string {
  let out = '';
  for (const raw of lines) {
    const line = raw.normalize('NFKC').trim();
    if (line === '') continue;
    if (out === '') {
      out = line;
      continue;
    }
    if (out.endsWith('\u00AD')) {
      out = out.slice(0, -1) + line;
      continue;
    }
    const hyphen = LINE_END_HYPHEN.exec(out);
    if (hyphen && LETTER.test(hyphen[1]) && STARTS_LOWERCASE.test(line)) {
      out = out.slice(0, -1) + line;
    } else if (hyphen) {
      out = out + line;
    } else {
      out = `${out} ${line}`;
    }
  }
  return normaliseText(out);
}

export interface PageLine {
  page: number;
  text: string;
}

/** How many lines at the top and bottom of a page can be a running header or footer. */
const EDGE_LINES = 3;

/** A line's shape: what stays the same when a page number changes. */
function shapeOf(text: string): string {
  return normaliseText(text).toLowerCase().replace(/\d+/g, '#');
}

/** Which edge slot a line sits in ("t0" = first line, "b0" = last), or null in the body. */
function slotOf(index: number, length: number): string | null {
  if (index < EDGE_LINES) return `t${index}`;
  if (index >= length - EDGE_LINES) return `b${length - 1 - index}`;
  return null;
}

/**
 * Removes running headers and footers: a line in one of the top or bottom
 * three slots of its page whose shape (digits ignored, so "Page 3 of 9"
 * matches "Page 4 of 9") fills the same slot on at least two pages and at
 * least half of all pages. A one-page document keeps every line.
 *
 * Ignoring digits means two body lines differing only in numbers, in the same
 * edge slot on half the pages, are dropped too. Real reports rarely do that,
 * and the person confirming the opinion sees the rendered page beside it.
 */
export function dropRunningLines(pages: readonly (readonly string[])[]): PageLine[] {
  const threshold = Math.max(2, Math.ceil(pages.length / 2));
  const keyOf = (text: string, index: number, length: number): string | null => {
    const slot = slotOf(index, length);
    const shape = shapeOf(text);
    return slot === null || shape === '' ? null : `${slot}|${shape}`;
  };

  const pagesWithKey = new Map<string, Set<number>>();
  pages.forEach((lines, page) => {
    lines.forEach((text, index) => {
      const key = keyOf(text, index, lines.length);
      if (key === null) return;
      let seen = pagesWithKey.get(key);
      if (!seen) pagesWithKey.set(key, (seen = new Set()));
      seen.add(page);
    });
  });

  const out: PageLine[] = [];
  pages.forEach((lines, page) => {
    lines.forEach((text, index) => {
      const key = keyOf(text, index, lines.length);
      if (key !== null && (pagesWithKey.get(key)?.size ?? 0) >= threshold) return;
      out.push({ page: page + 1, text });
    });
  });
  return out;
}
