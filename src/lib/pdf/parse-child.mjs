// Runs in a child process that src/lib/pdf/parse.ts forks for every PDF. It
// receives one file over IPC, sends back one answer and exits. It is plain
// JavaScript so Node runs it with no loader, and it touches nothing but the
// bytes it was sent: no filesystem writes, no network, no logging (its stdio
// is closed by the parent).
//
// A hostile PDF can at worst exhaust this process. The parent caps its heap,
// kills it after a timeout, and checks the shape of whatever it answers.
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

const round = (n) => Math.round(n * 100) / 100;

/** Groups glyphs into lines by baseline, top to bottom. */
function groupLines(glyphs) {
  const sorted = [...glyphs].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  for (const g of sorted) {
    const line = lines[lines.length - 1];
    if (line && Math.abs(line.y - g.y) <= 0.4 * Math.max(line.size, g.size)) {
      line.parts.push(g);
      line.size = Math.max(line.size, g.size);
    } else {
      lines.push({ y: g.y, size: g.size, parts: [g] });
    }
  }
  return lines;
}

/** The narrowest gap, in points, that can separate two columns. */
const MIN_GUTTER = 8;
/**
 * The smallest share of a band's text each side of a gutter must hold. A
 * margin of paragraph numbers ("1.", "2.") leaves a gap too, but is not a
 * column.
 */
const MIN_COLUMN_SHARE = 0.15;
/** How many lines a band needs before its gap is read as a column gutter. */
const MIN_BAND_LINES = 3;

/**
 * Text that puts ink on the page. pdf.js inserts whitespace items where a run
 * jumps sideways, and one can stretch straight across a column gutter.
 */
const inked = (p) => p.str.trim() !== '';

/** Which points across the page a line puts ink on. */
function inkOf(line, left, width) {
  const ink = new Uint8Array(width);
  for (const p of line.parts.filter(inked)) {
    for (let x = Math.max(0, Math.floor(p.x) - left); x <= Math.min(width - 1, Math.ceil(p.x + p.w) - left); x++) ink[x] = 1;
  }
  return ink;
}

/**
 * The gutters in `free` (points no line of the band inks): runs at least
 * MIN_GUTTER wide with at least MIN_COLUMN_SHARE of the band's text on each
 * side. Returns their centres, left to right.
 */
function guttersIn(free, lines, left) {
  const parts = lines.flatMap((l) => l.parts).filter(inked);
  const total = parts.reduce((n, p) => n + p.str.length, 0);
  const share = (test) => parts.reduce((n, p) => (test(p) ? n + p.str.length : n), 0) / total;
  const gutters = [];
  let run = -1;
  for (let i = 0; i <= free.length; i++) {
    const open = i < free.length && free[i] === 1;
    if (open && run < 0) run = i;
    if (!open && run >= 0) {
      const from = left + run;
      const to = left + i - 1;
      if (to - from + 1 >= MIN_GUTTER && share((p) => p.x + p.w <= from + 1) >= MIN_COLUMN_SHARE && share((p) => p.x >= to - 1) >= MIN_COLUMN_SHARE) {
        gutters.push((from + to) / 2);
      }
      run = -1;
    }
  }
  return gutters;
}

/**
 * Splits a page's lines, top to bottom, into bands. A band is a run of lines
 * that all leave the same vertical gaps unprinted, with text on both sides: a
 * stretch of two or three columns. A line joins the band only if together
 * they keep every gutter either had alone, so a line that runs across a gap
 * (a title, a full-width table) starts a new band rather than erasing the
 * gap for lines it has nothing to do with. Pages often mix layouts, so
 * columns are found band by band, not for the whole page.
 */
function bandsOf(lines) {
  if (lines.length === 0) return [];
  const parts = lines.flatMap((l) => l.parts);
  const left = Math.floor(Math.min(...parts.map((p) => p.x)));
  const width = Math.ceil(Math.max(...parts.map((p) => p.x + p.w))) - left + 1;
  const bands = [];
  let band = null;
  for (const line of lines) {
    const ink = inkOf(line, left, width);
    const own = ink.map((v) => 1 - v);
    const ownGutters = guttersIn(own, [line], left).length;
    if (band) {
      const free = band.free.map((f, i) => f & own[i]);
      const joined = guttersIn(free, [...band.lines, line], left).length;
      if (joined >= Math.max(1, band.gutters, ownGutters)) {
        band.lines.push(line);
        band.free = free;
        band.gutters = joined;
        continue;
      }
      bands.push(band);
    }
    band = { lines: [line], free: own, gutters: ownGutters };
  }
  bands.push(band);
  return bands.map((b) => ({ lines: b.lines, gutters: b.lines.length >= MIN_BAND_LINES ? guttersIn(b.free, b.lines, left) : [] }));
}

function lineText(line) {
  line.parts.sort((a, b) => a.x - b.x);
  let text = '';
  let prev = null;
  for (const p of line.parts) {
    if (prev) {
      const gap = p.x - (prev.x + prev.w);
      if (gap > 0.15 * line.size && !/\s$/.test(text) && !/^\s/.test(p.str)) text += ' ';
    }
    text += p.str;
    prev = p;
  }
  return { text: text.trim(), x: round(line.parts[0].x), y: round(line.y), size: round(line.size) };
}

/**
 * Groups positioned text items into lines in reading order: band by band down
 * the page, and within a multi-column band column by column, left to right,
 * each top to bottom. Without the column split a two-column page reads as
 * lines that join both columns, so a heading shares its line with the other
 * column's text and is never found.
 */
function linesOf(items) {
  const glyphs = [];
  for (const item of items) {
    if (typeof item.str !== 'string' || item.str === '') continue;
    const [, , c, d, x, y] = item.transform;
    const size = Math.hypot(c, d) || item.height || 1;
    glyphs.push({ str: item.str, x, y, w: item.width, size });
  }
  return bandsOf(groupLines(glyphs)).flatMap(({ lines, gutters }) => {
    if (gutters.length === 0) return lines.map(lineText);
    const columns = Array.from({ length: gutters.length + 1 }, () => []);
    for (const p of lines.flatMap((l) => l.parts)) columns[gutters.filter((at) => p.x > at).length].push(p);
    return columns.flatMap((column) => groupLines(column).map(lineText));
  });
}

function stringsOf(dict) {
  const out = {};
  if (!dict || typeof dict !== 'object') return out;
  // pdf.js 6 hands custom Info keys over as a Map, the standard ones as an object.
  for (const [key, value] of dict instanceof Map ? dict.entries() : Object.entries(dict)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

async function extract(bytes, limits) {
  let doc;
  try {
    doc = await pdfjs.getDocument({
      data: bytes,
      disableFontFace: true,
      useSystemFonts: false,
      enableXfa: false,
      isOffscreenCanvasSupported: false,
      verbosity: 0,
    }).promise;
  } catch (error) {
    if (error?.name === 'PasswordException') return { ok: false, reason: 'ENCRYPTED' };
    return { ok: false, reason: 'UNPARSEABLE', detail: String(error?.name ?? 'Error') };
  }

  const { info, metadata } = await doc.getMetadata();
  const pageCount = doc.numPages;
  if (!Number.isInteger(pageCount) || pageCount < 1) return { ok: false, reason: 'UNPARSEABLE', detail: 'no pages' };
  if (pageCount > limits.maxPages) return { ok: false, reason: 'TOO_MANY_PAGES' };

  const pages = [];
  let textChars = 0;
  for (let n = 1; n <= pageCount; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    const lines = linesOf(content.items);
    for (const line of lines) textChars += line.text.replace(/\s/g, '').length;
    if (textChars > limits.maxTextChars) return { ok: false, reason: 'TOO_MUCH_TEXT' };
    pages.push({ lines });
    page.cleanup();
  }

  const [attachments, jsActions, fields] = await Promise.all([doc.getAttachments(), doc.getJSActions(), doc.getFieldObjects()]);
  const fieldList = fields ? Object.values(fields).flat() : [];
  const flags = {
    signed: Boolean(info?.IsSignaturesPresent) || fieldList.some((f) => f?.type === 'signature'),
    javascript: Boolean(jsActions && Object.keys(jsActions).length > 0),
    embeddedFiles: Boolean(attachments && Object.keys(attachments).length > 0),
    xfa: Boolean(info?.IsXFAPresent),
    // Opened without a password, yet encrypted: an owner password that only
    // restricts editing. Accepted anchor-only (#74).
    editProtected: Boolean(info?.EncryptFilterName),
  };

  const xmp = metadata && typeof metadata.getRaw === 'function' ? metadata.getRaw() : null;
  const custom = stringsOf(info?.Custom);
  return {
    ok: true,
    pdf: {
      pageCount,
      pages,
      textChars,
      info: { ...stringsOf(info), ...Object.fromEntries(Object.entries(custom).map(([k, v]) => [`Custom:${k}`, v])) },
      xmp: typeof xmp === 'string' && xmp.length <= limits.maxXmpChars ? xmp : null,
      flags,
    },
  };
}

process.once('message', async (message) => {
  let answer;
  try {
    answer = await extract(new Uint8Array(message.bytes), message.limits);
  } catch (error) {
    answer = { ok: false, reason: "UNPARSEABLE", detail: String(error?.name ?? "Error") };
  }
  process.send(answer, () => process.exit(0));
});
