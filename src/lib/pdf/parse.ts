import { z } from 'zod';
import { childScriptPath, runIsolated } from './isolated';

/**
 * Parses an untrusted PDF without letting it near the server process.
 *
 * pdfjs runs in a forked child process, not a worker thread: a worker shares
 * the server's address space, and V8's heap limit does not cover the
 * ArrayBuffers a decompression bomb inflates into. A child can be killed
 * outright, and if the operating system kills it for memory, the server lives
 * on. runIsolated (./isolated.ts) caps its heap, its whole memory and its
 * time, gives it an empty environment and runs a few at once (#154). Every outcome is either a parsed PDF or a named refusal (CLAUDE.md
 * rule 7); nothing here logs PDF bytes or text.
 */

export const PDF_LIMITS = {
  maxBytes: 25 * 1024 * 1024,
  maxPages: 500,
  timeoutMs: 20_000,
  heapMb: 512,
  /** The child's whole memory, ArrayBuffers included, which the heap cap does not count (#154). */
  memoryMb: 1024,
  maxTextChars: 2_000_000,
  maxXmpChars: 1_000_000,
} as const;

export type PdfLimits = { -readonly [K in keyof typeof PDF_LIMITS]: number };

export const PDF_REFUSALS = [
  'NOT_A_PDF',
  'TRUNCATED',
  'TOO_LARGE',
  'TOO_MANY_PAGES',
  'TOO_MUCH_TEXT',
  'ENCRYPTED',
  'UNPARSEABLE',
  'TIMEOUT',
  'RESOURCE_LIMIT',
  'PARSER_CRASHED',
] as const;
export type PdfRefusal = (typeof PDF_REFUSALS)[number];

const Line = z.strictObject({ text: z.string(), x: z.number(), y: z.number(), size: z.number() });
const Flags = z.strictObject({
  signed: z.boolean(),
  javascript: z.boolean(),
  embeddedFiles: z.boolean(),
  xfa: z.boolean(),
  /** Encrypted with an owner password only: it opens freely but restricts editing (#74). */
  editProtected: z.boolean(),
});
const ParsedPdfSchema = z.strictObject({
  pageCount: z.int().min(1),
  pages: z.array(z.strictObject({ lines: z.array(Line) })),
  textChars: z.int().min(0),
  info: z.record(z.string(), z.string()),
  xmp: z.string().nullable(),
  flags: Flags,
});
const ChildAnswer = z.union([
  z.strictObject({ ok: z.literal(true), pdf: ParsedPdfSchema }),
  z.strictObject({ ok: z.literal(false), reason: z.enum(PDF_REFUSALS), detail: z.string().max(200).optional() }),
]);

export type ParsedPdf = z.infer<typeof ParsedPdfSchema>;
export type PdfFlags = z.infer<typeof Flags>;
export type ParseResult = { ok: true; pdf: ParsedPdf } | { ok: false; reason: PdfRefusal; detail?: string };

const PDF_HEADER = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"
const EOF_MARKER = Buffer.from('%%EOF', 'latin1');
/** How far from the end the last "%%EOF" may sit; writers pad with a little whitespace. */
const EOF_WINDOW = 1024;

/** The parser's child script, run under plain Node (see childScriptPath). */
export const parserChildPath = (): string => childScriptPath('parse-child.mjs');

const FLAG_OF_NAME: Record<string, keyof PdfFlags> = {
  ByteRange: 'signed',
  JavaScript: 'javascript',
  JS: 'javascript',
  EmbeddedFile: 'embeddedFiles',
  EmbeddedFiles: 'embeddedFiles',
  XFA: 'xfa',
  Encrypt: 'editProtected',
};

/**
 * Names that mark active or embedded content, found by scanning the raw
 * bytes. pdfjs reports some of the same things; either one raising a flag is
 * enough. Names may be written with #xx escapes ("/Java#53cript"), which are
 * decoded first. This runs in the server process, so it keeps no per-name
 * state: a file of millions of distinct names costs time, not memory.
 */
export function scanRawFlags(bytes: Uint8Array): PdfFlags {
  const flags: PdfFlags = { signed: false, javascript: false, embeddedFiles: false, xfa: false, editProtected: false };
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1');
  // Only names short enough to be one of ours, made of letters and escapes.
  for (const match of text.matchAll(/\/((?:[A-Za-z]|#[0-9A-Fa-f]{2}){2,40})(?![^\s/<>[\]()%{}])/g)) {
    const name = match[1].replace(/#([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
    const flag = FLAG_OF_NAME[name];
    if (flag) flags[flag] = true;
  }
  return flags;
}

export async function parsePdf(bytes: Uint8Array, overrides: Partial<PdfLimits> = {}): Promise<ParseResult> {
  const limits: PdfLimits = { ...PDF_LIMITS, ...overrides };
  if (bytes.byteLength > limits.maxBytes) return { ok: false, reason: 'TOO_LARGE' };
  if (bytes.byteLength < PDF_HEADER.length || PDF_HEADER.some((b, i) => bytes[i] !== b)) {
    return { ok: false, reason: 'NOT_A_PDF' };
  }
  // pdfjs recovers what it can from a cut-off file, which would hand back a
  // partial report as if it were whole.
  const tail = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).subarray(-EOF_WINDOW);
  if (!tail.includes(EOF_MARKER)) return { ok: false, reason: 'TRUNCATED' };

  const answer = await runChild(bytes, limits);
  if (!answer.ok) return answer;
  const raw = scanRawFlags(bytes);
  const flags = Object.fromEntries(
    (Object.keys(raw) as (keyof PdfFlags)[]).map((name) => [name, answer.pdf.flags[name] || raw[name]]),
  ) as PdfFlags;
  return { ok: true, pdf: { ...answer.pdf, flags } };
}

async function runChild(bytes: Uint8Array, limits: PdfLimits): Promise<ParseResult> {
  const { maxPages, maxTextChars, maxXmpChars } = limits;
  const outcome = await runIsolated(parserChildPath(), { bytes, limits: { maxPages, maxTextChars, maxXmpChars } }, limits);
  if (!outcome.ok) return outcome.reason === 'CRASHED' ? { ok: false, reason: 'PARSER_CRASHED', detail: outcome.detail } : { ok: false, reason: outcome.reason };
  const parsed = ChildAnswer.safeParse(outcome.answer);
  return parsed.success ? parsed.data : { ok: false, reason: 'PARSER_CRASHED', detail: 'malformed answer' };
}
