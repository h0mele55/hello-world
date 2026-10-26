import { PDFArray, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFString } from '@cantoo/pdf-lib';
import { sha256, signDetached } from './cms';
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

export { checkSeal, readSeal, type SealCheck, type SealReading } from '../verify-core/seal';
