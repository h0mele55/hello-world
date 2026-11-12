import { docHashOf } from './commitments';
import { editPdf } from './pdf/edit';
import type { IsolationLimits } from './pdf/isolated';
import { parsePdf } from './pdf/parse';
import { fieldOf, infoKeyOf, INFO_KEY_PREFIX, readStamp, STAMP_FIELD_NAMES, STAMP_NAMESPACE, STAMP_PREFIX, stampValues, type StampFields } from './stamp-fields';

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
 *
 * pdf-lib reads the original in an isolated child (src/lib/pdf/edit.ts,
 * #154), never in the worker: a file that inflates past the child's memory
 * or time is RESOURCE_LIMIT, for a person to look at.
 */

export class StampError extends Error {
  constructor(
    readonly code: 'ENCRYPTED' | 'ALREADY_STAMPED' | 'NOT_INCREMENTAL' | 'UNREADABLE' | 'RESOURCE_LIMIT',
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

const STAMP_ERRORS: Record<string, string> = {
  ENCRYPTED: 'an encrypted PDF is anchored as it is, never stamped',
  ALREADY_STAMPED: 'the PDF already carries an anchor stamp',
  UNREADABLE: 'the PDF could not be opened for stamping',
  RESOURCE_LIMIT: 'the PDF needs more memory or time to open than a report should',
  NOT_INCREMENTAL: 'the stamped file does not begin with the original',
};

export async function stampPdf(original: Uint8Array, fields: StampFields, limits: Partial<IsolationLimits> = {}): Promise<Uint8Array> {
  const values = stampValues(fields);
  const description = descriptionOf(values);
  const edited = await editPdf(
    original,
    {
      kind: 'stamp',
      namespace: STAMP_NAMESPACE,
      infoKeyPrefix: INFO_KEY_PREFIX,
      description,
      freshPacket: freshPacket(description),
      info: values.map(([name, value]) => [infoKeyOf(name), value]),
    },
    limits,
  );
  if (!edited.ok) throw new StampError(edited.code, STAMP_ERRORS[edited.code]);
  return edited.bytes;
}

export type StampCheck = { ok: true; docHash: `0x${string}` } | { ok: false; reason: string };

/**
 * Re-reads a stamped copy through the isolated parser before it is anchored
 * (Phase 3 hardening): it must begin with the original, parse to the same pages
 * and text with the same flags, and carry exactly the expected stamp in both
 * its XMP and its Info dictionary. A sealed copy (`sealed`, #70) is held to
 * the same, but for the signature it adds.
 */
export async function checkStampedCopy(original: Uint8Array, stamped: Uint8Array, expected: StampFields, options: { sealed?: boolean } = {}): Promise<StampCheck> {
  if (stamped.length <= original.length || !Buffer.from(stamped.subarray(0, original.length)).equals(Buffer.from(original))) {
    return { ok: false, reason: 'NOT_INCREMENTAL' };
  }
  const [before, after] = await Promise.all([parsePdf(original), parsePdf(stamped)]);
  if (!before.ok) return { ok: false, reason: `ORIGINAL_REFUSED:${before.reason}` };
  if (!after.ok) return { ok: false, reason: `COPY_REFUSED:${after.reason}` };
  if (after.pdf.pageCount !== before.pdf.pageCount) return { ok: false, reason: 'PAGE_COUNT_CHANGED' };
  if (JSON.stringify(after.pdf.pages) !== JSON.stringify(before.pdf.pages)) return { ok: false, reason: 'TEXT_CHANGED' };
  // A sealed copy (#70) differs from its original by its signature, and by nothing else.
  const flags = options.sealed ? { ...before.pdf.flags, signed: true } : before.pdf.flags;
  if (JSON.stringify(after.pdf.flags) !== JSON.stringify(flags)) return { ok: false, reason: 'FLAGS_CHANGED' };
  const reading = readStamp(after.pdf.xmp, after.pdf.info);
  if (reading.status !== 'FOUND' || !reading.inXmp || !reading.inInfo) return { ok: false, reason: `STAMP_${reading.status}` };
  if (STAMP_FIELD_NAMES.some((name) => String(fieldOf(reading.fields, name)) !== String(fieldOf(expected, name)))) return { ok: false, reason: 'STAMP_MISMATCH' };
  return { ok: true, docHash: docHashOf(stamped) };
}
