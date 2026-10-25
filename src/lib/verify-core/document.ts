import { infoOf, xmpOf } from './metadata.mjs';
import { readPages } from './pages.mjs';

/**
 * Opens a PDF with whichever pdf.js build the caller has (the browser's, or
 * Node's legacy build) and reads what a verifier needs: each page's lines and
 * the metadata a stamp lives in. The same readers the server's isolated parser
 * uses, so both read the same text from the same file.
 */

export const VERIFY_LIMITS = { maxBytes: 25 * 1024 * 1024, maxPages: 500, maxTextChars: 2_000_000, maxXmpChars: 1_000_000 } as const;

export interface ReadDocument {
  /** Each page's line texts, in reading order. */
  pageLines: string[][];
  xmp: string | null;
  info: Record<string, string>;
}

export type DocumentRead = { ok: true; doc: ReadDocument } | { ok: false; reason: 'TOO_LARGE' | 'UNPARSEABLE' | 'ENCRYPTED' | 'TOO_MANY_PAGES' | 'TOO_MUCH_TEXT' };

/** The part of pdf.js this needs. */
export interface PdfjsLike {
  getDocument(source: Record<string, unknown>): { promise: Promise<PdfjsDocument>; destroy(): Promise<void> };
}

interface PdfjsDocument {
  numPages: number;
  getPage(n: number): Promise<{ getTextContent(): Promise<{ items: unknown[] }>; cleanup(): unknown }>;
  getMetadata(): Promise<{ info: unknown; metadata: unknown }>;
}

export async function readDocument(pdfjs: PdfjsLike, bytes: Uint8Array, limits = VERIFY_LIMITS): Promise<DocumentRead> {
  if (bytes.length > limits.maxBytes) return { ok: false, reason: 'TOO_LARGE' };
  // pdf.js takes ownership of the buffer it is given: hand it a copy.
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    disableFontFace: true,
    useSystemFonts: false,
    enableXfa: false,
    isOffscreenCanvasSupported: false,
    // Untrusted files: never compile font programs into functions.
    isEvalSupported: false,
    verbosity: 0,
  });
  try {
    let doc: PdfjsDocument;
    try {
      doc = await task.promise;
    } catch (error) {
      return { ok: false, reason: (error as { name?: string } | null)?.name === 'PasswordException' ? 'ENCRYPTED' : 'UNPARSEABLE' };
    }
    if (!Number.isInteger(doc.numPages) || doc.numPages < 1) return { ok: false, reason: 'UNPARSEABLE' };
    if (doc.numPages > limits.maxPages) return { ok: false, reason: 'TOO_MANY_PAGES' };
    const { info, metadata } = await doc.getMetadata();
    const read = await readPages(doc, limits.maxTextChars);
    if (read.tooMuchText) return { ok: false, reason: 'TOO_MUCH_TEXT' };
    return { ok: true, doc: { pageLines: read.pages.map((page) => page.lines.map((line) => line.text)), xmp: xmpOf(metadata, limits.maxXmpChars), info: infoOf(info) } };
  } finally {
    await task.destroy();
  }
}
