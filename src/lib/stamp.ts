import { decodePDFRawStream, EncryptedPDFError, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFString } from '@cantoo/pdf-lib';
import { docHashOf } from './commitments';
import { parsePdf } from './pdf/parse';
import { infoKeyOf, INFO_KEY_PREFIX, readStamp, STAMP_FIELD_NAMES, STAMP_NAMESPACE, STAMP_PREFIX, stampValues, type StampFields } from './stamp-fields';

/**
 * Stamping: writes a version's anchor into the PDF's XMP metadata and Info
 * dictionary as an incremental update. The original file is left byte for
 * byte as the stamped file's prefix, so its pages are untouched by
 * construction, and the stamped file is the distribution copy anchored as the
 * original's DISTRIBUTION_COPY.
 *
 * Stamping is deterministic: the same original and fields give the same
 * bytes, so a retry produces the same copy (the registry allows one copy per
 * original). A signed or edit-protected file is never stamped (#74).
 */

export class StampError extends Error {
  constructor(
    readonly code: 'ENCRYPTED' | 'ALREADY_STAMPED' | 'NOT_INCREMENTAL' | 'UNREADABLE',
    message: string,
  ) {
    super(message);
    this.name = 'StampError';
  }
}

const XPACKET_ID = 'W5M0MpCehiHzreSzNTczkc9d';

const escapeXml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function descriptionOf(values: [string, string][]): string {
  const elements = values.map(([name, value]) => `<${STAMP_PREFIX}:${name}>${escapeXml(value)}</${STAMP_PREFIX}:${name}>`).join('');
  return `<rdf:Description rdf:about="" xmlns:${STAMP_PREFIX}="${STAMP_NAMESPACE}">${elements}</rdf:Description>`;
}

function freshPacket(description: string): string {
  return (
    `<?xpacket begin="\u{FEFF}" id="${XPACKET_ID}"?>` +
    `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">${description}</rdf:RDF></x:xmpmeta>` +
    `<?xpacket end="w"?>`
  );
}

/** The document's current XMP packet as text, or null when absent or unreadable. */
function existingXmp(doc: PDFDocument): string | null {
  try {
    const stream = doc.catalog.lookup(PDFName.of('Metadata'));
    if (!(stream instanceof PDFRawStream)) return null;
    return new TextDecoder('utf-8', { fatal: true }).decode(decodePDFRawStream(stream).decode());
  } catch {
    return null;
  }
}

/** The trailer's Info dictionary, created when the document has none. */
function infoDictOf(doc: PDFDocument): PDFDict {
  const existing = doc.context.lookup(doc.context.trailerInfo.Info);
  if (existing instanceof PDFDict) return existing;
  const created = doc.context.obj({});
  doc.context.trailerInfo.Info = doc.context.register(created);
  return created;
}

export async function stampPdf(original: Uint8Array, fields: StampFields): Promise<Uint8Array> {
  const values = stampValues(fields);
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(original, { forIncrementalUpdate: true, updateMetadata: false });
  } catch (error) {
    if (error instanceof EncryptedPDFError) throw new StampError('ENCRYPTED', 'an encrypted PDF is anchored as it is, never stamped');
    throw new StampError('UNREADABLE', 'the PDF could not be opened for stamping');
  }
  if (doc.isEncrypted) throw new StampError('ENCRYPTED', 'an encrypted PDF is anchored as it is, never stamped');

  const xmp = existingXmp(doc);
  const info = infoDictOf(doc);
  const alreadyStamped = (xmp?.includes(STAMP_NAMESPACE) ?? false) || info.keys().some((key) => key.decodeText().startsWith(INFO_KEY_PREFIX));
  if (alreadyStamped) throw new StampError('ALREADY_STAMPED', 'the PDF already carries an anchor stamp');

  // Keep the document's own XMP when it can be extended in one place;
  // otherwise write a fresh packet (the old one stays in the original bytes).
  const description = descriptionOf(values);
  const merged = xmp && xmp.split('</rdf:RDF>').length === 2 ? xmp.replace('</rdf:RDF>', `${description}</rdf:RDF>`) : freshPacket(description);
  const metadata = doc.context.stream(new TextEncoder().encode(merged), { Type: 'Metadata', Subtype: 'XML' });
  doc.catalog.set(PDFName.of('Metadata'), doc.context.register(metadata));
  for (const [name, value] of values) info.set(PDFName.of(infoKeyOf(name as keyof StampFields)), PDFString.of(value));

  const stamped = await doc.commit();
  if (stamped.length <= original.length || !Buffer.from(stamped.subarray(0, original.length)).equals(Buffer.from(original))) {
    throw new StampError('NOT_INCREMENTAL', 'the stamped file does not begin with the original');
  }
  return stamped;
}

export type StampCheck = { ok: true; docHash: `0x${string}` } | { ok: false; reason: string };

/**
 * Re-reads a stamped copy through the isolated parser before it is anchored
 * (Phase 3 hardening): it must begin with the original, parse to the same pages
 * and text with the same flags, and carry exactly the expected stamp in both
 * its XMP and its Info dictionary.
 */
export async function checkStampedCopy(original: Uint8Array, stamped: Uint8Array, expected: StampFields): Promise<StampCheck> {
  if (stamped.length <= original.length || !Buffer.from(stamped.subarray(0, original.length)).equals(Buffer.from(original))) {
    return { ok: false, reason: 'NOT_INCREMENTAL' };
  }
  const [before, after] = await Promise.all([parsePdf(original), parsePdf(stamped)]);
  if (!before.ok) return { ok: false, reason: `ORIGINAL_REFUSED:${before.reason}` };
  if (!after.ok) return { ok: false, reason: `COPY_REFUSED:${after.reason}` };
  if (after.pdf.pageCount !== before.pdf.pageCount) return { ok: false, reason: 'PAGE_COUNT_CHANGED' };
  if (JSON.stringify(after.pdf.pages) !== JSON.stringify(before.pdf.pages)) return { ok: false, reason: 'TEXT_CHANGED' };
  if (JSON.stringify(after.pdf.flags) !== JSON.stringify(before.pdf.flags)) return { ok: false, reason: 'FLAGS_CHANGED' };
  const reading = readStamp(after.pdf.xmp, after.pdf.info);
  if (reading.status !== 'FOUND' || !reading.inXmp || !reading.inInfo) return { ok: false, reason: `STAMP_${reading.status}` };
  if (STAMP_FIELD_NAMES.some((name) => String(reading.fields[name]) !== String(expected[name]))) return { ok: false, reason: 'STAMP_MISMATCH' };
  return { ok: true, docHash: docHashOf(stamped) };
}
