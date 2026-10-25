// Runs in a child process that src/lib/pdf/parse.ts forks for every PDF. It
// receives one file over IPC, sends back one answer and exits. It is plain
// JavaScript so Node runs it with no loader, and it touches nothing but the
// bytes it was sent: no filesystem writes, no network, no logging (its stdio
// is closed by the parent).
//
// A hostile PDF can at worst exhaust this process. The parent caps its heap,
// kills it after a timeout, and checks the shape of whatever it answers.
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { infoOf, xmpOf } from '../verify-core/metadata.mjs';
import { readPages } from '../verify-core/pages.mjs';

async function extract(bytes, limits) {
  let doc;
  try {
    doc = await pdfjs.getDocument({
      data: bytes,
      disableFontFace: true,
      useSystemFonts: false,
      enableXfa: false,
      isOffscreenCanvasSupported: false,
    // Untrusted files: never compile font programs into functions.
    isEvalSupported: false,
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

  const read = await readPages(doc, limits.maxTextChars);
  if (read.tooMuchText) return { ok: false, reason: 'TOO_MUCH_TEXT' };
  const { pages, textChars } = read;

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

  return {
    ok: true,
    pdf: {
      pageCount,
      pages,
      textChars,
      info: infoOf(info),
      xmp: xmpOf(metadata, limits.maxXmpChars),
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
