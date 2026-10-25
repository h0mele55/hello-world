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

/** Groups positioned text items into lines, top to bottom, left to right. */
function linesOf(items) {
  const glyphs = [];
  for (const item of items) {
    if (typeof item.str !== 'string' || item.str === '') continue;
    const [, , c, d, x, y] = item.transform;
    const size = Math.hypot(c, d) || item.height || 1;
    glyphs.push({ str: item.str, x, y, w: item.width, size });
  }
  glyphs.sort((a, b) => b.y - a.y || a.x - b.x);

  const lines = [];
  for (const g of glyphs) {
    const line = lines[lines.length - 1];
    if (line && Math.abs(line.y - g.y) <= 0.4 * Math.max(line.size, g.size)) {
      line.parts.push(g);
      line.size = Math.max(line.size, g.size);
    } else {
      lines.push({ y: g.y, size: g.size, parts: [g] });
    }
  }

  return lines.map((line) => {
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
    return { text, x: round(line.parts[0].x), y: round(line.y), size: round(line.size) };
  });
}

function stringsOf(dict) {
  const out = {};
  if (!dict || typeof dict !== 'object') return out;
  for (const [key, value] of Object.entries(dict)) {
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
