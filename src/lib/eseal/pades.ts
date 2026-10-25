import { PDFArray, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFString } from '@cantoo/pdf-lib';
import { checkDetached, sha256, signDetached } from './cms';
import { SealError, type SealSigner, type Timestamper } from './types';

/**
 * The firm's seal on a distribution copy (#70): a PAdES signature (ETSI EN
 * 319 142-1, baseline B-T) added to the stamped copy as one more incremental
 * update, before the copy is anchored. The stamped file stays byte for byte
 * as its prefix, so the anchor stamp and every page are untouched, and the
 * file anchored is the sealed one: the seal complements the anchor and the
 * anchor complements the seal.
 *
 * Sealing is not deterministic (the time is the timestamping authority's), so
 * a sealed copy is made once and kept; a retry anchors the kept file.
 */

/** Space reserved for the CMS signature: a chain of three and a timestamp fit with room to spare. */
export const SEAL_CONTENTS_BYTES = 32 * 1024;
const PLACEHOLDER = 1_111_111_111;
const FIELD_NAME = 'AnchorSeal';

const ascii = (bytes: Uint8Array) => Buffer.from(bytes).toString('latin1');
const pdfDate = (d: Date) => {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `D:${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
};

export interface SealOptions {
  signer: SealSigner;
  timestamper: Timestamper;
  /** The claimed signing time, written as /M; the timestamp is what proves the time. */
  signingTime: Date;
  /** Shown by PDF readers as the reason for the signature. */
  reason: string;
}

export async function sealPdf(stamped: Uint8Array, options: SealOptions): Promise<Uint8Array> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(stamped, { forIncrementalUpdate: true, updateMetadata: false });
  } catch {
    throw new SealError('PDF_REFUSED', 'the PDF could not be opened for sealing');
  }
  if (doc.isEncrypted) throw new SealError('PDF_REFUSED', 'an encrypted PDF is never sealed');
  if (ascii(stamped).includes('/ByteRange')) throw new SealError('PDF_REFUSED', 'the PDF already carries a signature');

  const ctx = doc.context;
  const byteRange = PDFArray.withContext(ctx);
  for (const n of [0, PLACEHOLDER, PLACEHOLDER, PLACEHOLDER]) byteRange.push(PDFNumber.of(n));
  const signature = ctx.obj({
    Type: 'Sig',
    Filter: 'Adobe.PPKLite',
    SubFilter: 'ETSI.CAdES.detached',
    ByteRange: byteRange,
    Contents: PDFHexString.of('0'.repeat(SEAL_CONTENTS_BYTES * 2)),
    M: PDFString.of(pdfDate(options.signingTime)),
    Reason: PDFHexString.fromText(options.reason),
  });
  const signatureRef = ctx.register(signature);
  const page = doc.getPage(0);
  // An invisible signature field: the seal changes nothing a reader sees on the pages.
  const widget = ctx.obj({
    Type: 'Annot',
    Subtype: 'Widget',
    FT: 'Sig',
    T: PDFString.of(FIELD_NAME),
    V: signatureRef,
    Rect: [0, 0, 0, 0],
    F: 132,
    P: page.ref,
  });
  const widgetRef = ctx.register(widget);
  page.node.addAnnot(widgetRef);
  const form = doc.catalog.getOrCreateAcroForm();
  form.addField(widgetRef);
  form.dict.set(PDFName.of('SigFlags'), PDFNumber.of(3));

  const prepared = new Uint8Array(await doc.commit());
  if (prepared.length <= stamped.length || !Buffer.from(prepared.subarray(0, stamped.length)).equals(Buffer.from(stamped))) {
    throw new SealError('PDF_REFUSED', 'the sealed file does not begin with the stamped file');
  }

  // Find the placeholders in the update just written, and fix the byte range around the signature.
  const tail = ascii(prepared.subarray(stamped.length));
  const rangeMatch = /\/ByteRange\s*\[\s*0\s+1111111111\s+1111111111\s+1111111111\s*\]/.exec(tail);
  const contentsMatch = new RegExp(`/Contents\\s*<(0{${SEAL_CONTENTS_BYTES * 2}})>`).exec(tail);
  if (!rangeMatch || !contentsMatch) throw new SealError('PDF_REFUSED', 'the signature placeholder was not written as expected');
  const contentsStart = stamped.length + contentsMatch.index + contentsMatch[0].indexOf('<');
  const contentsEnd = contentsStart + SEAL_CONTENTS_BYTES * 2 + 2;
  const ranges = [0, contentsStart, contentsEnd, prepared.length - contentsEnd];
  const written = `/ByteRange [${ranges.join(' ')}]`;
  if (written.length > rangeMatch[0].length) throw new SealError('PDF_REFUSED', 'the byte range does not fit its placeholder');
  const out = prepared.slice();
  out.set(Buffer.from(written.padEnd(rangeMatch[0].length, ' '), 'latin1'), stamped.length + rangeMatch.index);

  const cms = await signDetached(sha256(out.subarray(0, contentsStart), out.subarray(contentsEnd)), options.signer, options.timestamper);
  if (cms.der.length > SEAL_CONTENTS_BYTES) throw new SealError('TOO_LARGE', `the signature is ${cms.der.length} bytes, over the ${SEAL_CONTENTS_BYTES} reserved`);
  out.set(Buffer.from(Buffer.from(cms.der).toString('hex').toUpperCase(), 'latin1'), contentsStart + 1);
  return out;
}

export interface SealReading {
  /** The bytes the seal covers: the whole file but the signature itself. */
  content: Uint8Array;
  /** The CMS signature, without the padding. */
  cms: Uint8Array;
  /** Where the signature's update begins: the file before it was sealed is the bytes up to here. */
  byteRange: [number, number, number, number];
}

/** The seal of a sealed file: the last signature, which must cover the whole file but its own contents. */
export function readSeal(bytes: Uint8Array): SealReading {
  const text = ascii(bytes);
  const at = text.lastIndexOf('/ByteRange');
  if (at < 0) throw new SealError('NO_SEAL', 'the file carries no signature');
  const match = /^\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/.exec(text.slice(at, at + 200));
  if (!match) throw new SealError('MALFORMED', 'the byte range cannot be read');
  const range = match.slice(1, 5).map(Number) as [number, number, number, number];
  const [start, firstLength, secondStart, secondLength] = range;
  if (start !== 0 || firstLength >= secondStart || secondStart + secondLength !== bytes.length) {
    throw new SealError('NOT_WHOLE_FILE', 'the signature does not cover the whole file but itself');
  }
  if (bytes[firstLength] !== 0x3c || bytes[secondStart - 1] !== 0x3e) throw new SealError('NOT_WHOLE_FILE', 'the byte range leaves out more than the signature');
  const hex = text.slice(firstLength + 1, secondStart - 1);
  if (!/^[0-9A-Fa-f]*$/.test(hex) || hex.length % 2) throw new SealError('MALFORMED', 'the signature contents are not hex');
  const padded = Buffer.from(hex, 'hex');
  // The DER length says where the signature ends; the rest is the placeholder's zeros.
  const cms = new Uint8Array(padded.subarray(0, derLength(padded)));
  if (padded.subarray(cms.length).some((b) => b !== 0)) throw new SealError('MALFORMED', 'bytes follow the signature in its contents');
  const content = new Uint8Array(firstLength + secondLength);
  content.set(bytes.subarray(0, firstLength));
  content.set(bytes.subarray(secondStart), firstLength);
  return { content, cms, byteRange: range };
}

function derLength(bytes: Uint8Array): number {
  if (bytes[0] !== 0x30) throw new SealError('MALFORMED', 'the signature is not a DER sequence');
  const first = bytes[1];
  if (first < 0x80) return 2 + first;
  const n = first & 0x7f;
  if (n === 0 || n > 4) throw new SealError('MALFORMED', 'the signature has an unreadable length');
  let length = 0;
  for (let i = 0; i < n; i++) length = length * 256 + bytes[2 + i];
  if (2 + n + length > bytes.length) throw new SealError('MALFORMED', 'the signature is longer than its contents');
  return 2 + n + length;
}

export interface SealCheck {
  /** The seal certificate's subject, as a string. */
  signer: string;
  /** The time the timestamping authority vouches for. */
  sealedAt: Date;
  timestampSerial: string;
}

/**
 * Checks a sealed copy: its seal covers the whole file but itself, the file
 * before the seal is `stamped` (when given), and the signature, the seal
 * certificate, its chain and the timestamp all hold against `trustAnchors`.
 */
export async function checkSeal(sealed: Uint8Array, trustAnchors: Uint8Array[], stamped?: Uint8Array): Promise<SealCheck> {
  const seal = readSeal(sealed);
  if (stamped && (sealed.length <= stamped.length || !Buffer.from(sealed.subarray(0, stamped.length)).equals(Buffer.from(stamped)))) {
    throw new SealError('NOT_WHOLE_FILE', 'the sealed file does not begin with the stamped file');
  }
  if (stamped && seal.byteRange[1] < stamped.length) throw new SealError('NOT_WHOLE_FILE', 'the signature lies inside the stamped file');
  const checked = await checkDetached(seal.cms, seal.content, trustAnchors);
  return {
    signer: checked.signer.subject.typesAndValues.map((tv) => `${tv.type === '2.5.4.3' ? 'CN' : tv.type === '2.5.4.10' ? 'O' : tv.type === '2.5.4.6' ? 'C' : tv.type}=${tv.value.valueBlock.value}`).join(', '),
    sealedAt: checked.sealedAt,
    timestampSerial: checked.timestampSerial,
  };
}
