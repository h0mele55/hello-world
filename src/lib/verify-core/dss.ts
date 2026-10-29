import { SealError } from '../eseal/types';
import { ascii } from './pki';
import type { ValidationData } from './revocation';

/**
 * The document security store a long-term seal adds (#119, PAdES B-LT): one
 * incremental update after the signed revision that redefines the catalog with
 * a /DSS entry and adds the DSS, the certificates and their statuses as
 * streams. Nothing else.
 *
 * `dssUpdate` writes it, and `readDssUpdate` accepts bytes after a seal only
 * when they are exactly what `dssUpdate` writes for the items they carry: the
 * update is parsed only far enough to find those items, written again, and
 * compared byte for byte. So whatever follows a seal can add validation data
 * and can change nothing a reader sees: not a page, an annotation or the
 * catalog's other entries. Isomorphic: string building only.
 */

export interface Revision {
  rootNumber: number;
  rootGeneration: number;
  /** The catalog's dictionary, as written. */
  catalog: string;
  size: number;
  /** Where this revision's xref table starts: the next update's /Prev. */
  startxref: number;
  info: string | null;
  id: string | null;
}

const notOurs = (detail: string) => new SealError('NOT_WHOLE_FILE', `bytes after the seal are not its validation data: ${detail}`);

/** Where the dictionary that opens at `start` ("<<") closes, skipping strings and nested dictionaries. */
function dictionaryEnd(text: string, start: number): number {
  if (!text.startsWith('<<', start)) throw notOurs('no dictionary where one was expected');
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === '(') {
      // A literal string: balanced parentheses, backslash escapes.
      let nest = 0;
      for (; i < text.length; i++) {
        if (text[i] === '\\') i++;
        else if (text[i] === '(') nest++;
        else if (text[i] === ')' && --nest === 0) break;
      }
    } else if (c === '<' && text[i + 1] === '<') {
      depth++;
      i++;
    } else if (c === '>' && text[i + 1] === '>') {
      depth--;
      i++;
      if (depth === 0) return i + 1;
    } else if (c === '<') {
      i = text.indexOf('>', i);
      if (i < 0) break;
    }
  }
  throw notOurs('a dictionary does not close');
}

/** An xref table's entries, from `xref` at `at`: object number to offset, for objects in use. */
function readXref(text: string, at: number): { entries: Map<number, { offset: number; generation: number }>; end: number } {
  const entries = new Map<number, { offset: number; generation: number }>();
  const head = /xref\r?\n/y;
  head.lastIndex = at;
  if (!head.exec(text)) throw new SealError('PDF_REFUSED', 'the revision before the seal’s validation data does not end in an xref table');
  let pos = head.lastIndex;
  const section = /(\d+) (\d+)[ ]?\r?\n/y;
  const entry = /(\d{10}) (\d{5}) ([nf])(?: \r?\n| ?\r\n| \r)/y;
  for (;;) {
    section.lastIndex = pos;
    const s = section.exec(text);
    if (!s) break;
    pos = section.lastIndex;
    const first = Number(s[1]);
    for (let n = 0; n < Number(s[2]); n++) {
      entry.lastIndex = pos;
      const e = entry.exec(text);
      if (!e) throw new SealError('PDF_REFUSED', 'an xref entry cannot be read');
      pos = entry.lastIndex;
      if (e[3] === 'n') entries.set(first + n, { offset: Number(e[1]), generation: Number(e[2]) });
    }
  }
  return { entries, end: pos };
}

/**
 * The last revision of a file whose last update ends in a classic xref table,
 * as the seal's update does: its catalog, size, trailer and where its table
 * starts. The catalog is looked up through /Prev while each earlier table is a
 * classic one too; anything else is refused rather than guessed at.
 */
export function readRevision(bytes: Uint8Array): Revision {
  const text = ascii(bytes);
  const last = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(text.slice(-1024));
  if (!last) throw new SealError('PDF_REFUSED', 'the file does not end in startxref and %%EOF');
  const startxref = Number(last[1]);
  const { entries, end } = readXref(text, startxref);
  const trailerAt = text.indexOf('trailer', end);
  if (trailerAt < 0 || trailerAt > end + 8) throw new SealError('PDF_REFUSED', 'the xref table has no trailer');
  const open = text.indexOf('<<', trailerAt);
  const trailer = text.slice(open, dictionaryEnd(text, open));
  const size = /\/Size\s+(\d+)/.exec(trailer);
  const root = /\/Root\s+(\d+)\s+(\d+)\s+R/.exec(trailer);
  if (!size || !root) throw new SealError('PDF_REFUSED', 'the trailer names no /Size or /Root');
  const rootNumber = Number(root[1]);
  const rootGeneration = Number(root[2]);

  // The catalog's latest definition: in this table, or an earlier classic one.
  let found = entries.get(rootNumber);
  let prev = /\/Prev\s+(\d+)/.exec(trailer);
  for (let depth = 0; !found && prev && depth < 64; depth++) {
    const older = readXref(text, Number(prev[1]));
    found = older.entries.get(rootNumber);
    const olderTrailerAt = text.indexOf('trailer', older.end);
    const olderOpen = text.indexOf('<<', olderTrailerAt);
    prev = /\/Prev\s+(\d+)/.exec(text.slice(olderOpen, dictionaryEnd(text, olderOpen)));
  }
  if (!found || found.generation !== rootGeneration) throw new SealError('PDF_REFUSED', 'the catalog cannot be found through classic xref tables');
  const objectHead = new RegExp(`${rootNumber} ${rootGeneration} obj\\s*`, 'y');
  objectHead.lastIndex = found.offset;
  if (!objectHead.exec(text)) throw new SealError('PDF_REFUSED', 'the catalog is not where its xref entry says');
  const catalogAt = objectHead.lastIndex;
  const catalog = text.slice(catalogAt, dictionaryEnd(text, catalogAt));
  return {
    rootNumber,
    rootGeneration,
    catalog,
    size: Number(size[1]),
    startxref,
    info: /\/Info\s+(\d+\s+\d+\s+R)/.exec(trailer)?.[1] ?? null,
    id: /\/ID\s*(\[[^\]]*\])/.exec(trailer)?.[1] ?? null,
  };
}

const pad = (n: number, width: number) => String(n).padStart(width, '0');
const refs = (from: number, count: number) => Array.from({ length: count }, (_, i) => `${from + i} 0 R`).join(' ');
const encoder = new TextEncoder();

/**
 * The bytes to append to `revisionBytes` to add `data` as its document security
 * store, the signature's VRI entry keyed by `vriKey`. Deterministic: the same
 * revision and items always give the same bytes.
 */
export function dssUpdate(revisionBytes: Uint8Array, data: ValidationData, vriKey: string): Uint8Array {
  if (!/^[0-9A-F]{40}$/.test(vriKey)) throw new SealError('MALFORMED', 'a VRI key is an upper-case SHA-1');
  const revision = readRevision(revisionBytes);
  if (/\/DSS\b/.test(revision.catalog)) throw new SealError('PDF_REFUSED', 'the file already carries validation data');
  if (data.certs.length === 0) throw new SealError('MALFORMED', 'validation data carries at least the seal’s certificates');

  const dssNumber = revision.size;
  const certsFrom = dssNumber + 1;
  const ocspsFrom = certsFrom + data.certs.length;
  const crlsFrom = ocspsFrom + data.ocsps.length;
  const next = crlsFrom + data.crls.length;
  const lists = (certKey: string, ocspKey: string, crlKey: string) =>
    [
      `/${certKey} [ ${refs(certsFrom, data.certs.length)} ]`,
      data.ocsps.length ? `/${ocspKey} [ ${refs(ocspsFrom, data.ocsps.length)} ]` : null,
      data.crls.length ? `/${crlKey} [ ${refs(crlsFrom, data.crls.length)} ]` : null,
    ]
      .filter(Boolean)
      .join('\n');
  const catalog = `${revision.catalog.slice(0, revision.catalog.lastIndexOf('>>'))}/DSS ${dssNumber} 0 R\n>>`;
  const dss = `<<\n/Type /DSS\n${lists('Certs', 'OCSPs', 'CRLs')}\n/VRI <<\n/${vriKey} <<\n${lists('Cert', 'OCSP', 'CRL')}\n>>\n>>\n>>`;

  const parts: Uint8Array[] = [];
  const offsets = new Map<number, number>();
  let at = revisionBytes.length;
  const push = (chunk: string | Uint8Array) => {
    const bytes = typeof chunk === 'string' ? encoder.encode(chunk) : chunk;
    parts.push(bytes);
    at += bytes.length;
  };
  push('\n');
  offsets.set(revision.rootNumber, at);
  push(`${revision.rootNumber} ${revision.rootGeneration} obj\n${catalog}\nendobj\n`);
  offsets.set(dssNumber, at);
  push(`${dssNumber} 0 obj\n${dss}\nendobj\n`);
  [...data.certs, ...data.ocsps, ...data.crls].forEach((der, i) => {
    offsets.set(certsFrom + i, at);
    push(`${certsFrom + i} 0 obj\n<< /Length ${der.length} >>\nstream\n`);
    push(der);
    push('\nendstream\nendobj\n');
  });
  const xrefAt = at;
  const entry = (n: number, generation = 0) => `${pad(offsets.get(n)!, 10)} ${pad(generation, 5)} n \n`;
  let xref = `xref\n0 1\n0000000000 65535 f \n${revision.rootNumber} 1\n${entry(revision.rootNumber, revision.rootGeneration)}${dssNumber} ${next - dssNumber}\n`;
  for (let n = dssNumber; n < next; n++) xref += entry(n);
  const trailer = [`/Size ${next}`, `/Root ${revision.rootNumber} ${revision.rootGeneration} R`, revision.info ? `/Info ${revision.info}` : null, revision.id ? `/ID ${revision.id}` : null, `/Prev ${revision.startxref}`]
    .filter(Boolean)
    .join(' ');
  push(`${xref}trailer\n<< ${trailer} >>\nstartxref\n${xrefAt}\n%%EOF\n`);

  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * The validation data that follows a seal ending at `signedEnd`, and the VRI
 * key it is filed under; refused (NOT_WHOLE_FILE) unless the bytes after the
 * seal are exactly the update `dssUpdate` writes for them.
 */
export function readDssUpdate(bytes: Uint8Array, signedEnd: number): { data: ValidationData; vriKey: string } {
  const revisionBytes = bytes.subarray(0, signedEnd);
  let revision: Revision;
  try {
    revision = readRevision(revisionBytes);
  } catch {
    throw notOurs('the sealed revision cannot be read');
  }
  const tail = ascii(bytes.subarray(signedEnd));
  const dssNumber = revision.size;
  const dssAt = tail.indexOf(`\n${dssNumber} 0 obj\n`);
  if (dssAt < 0) throw notOurs('no document security store');
  const dictAt = dssAt + `\n${dssNumber} 0 obj\n`.length;
  const dss = tail.slice(dictAt, dictionaryEnd(tail, dictAt));
  const list = (key: string) => {
    const m = new RegExp(`\\n/${key} \\[ ([0-9 R]*) \\]`).exec(dss);
    return m ? m[1].split(' 0 R').map((s) => s.trim()).filter(Boolean).map(Number) : [];
  };
  const vri = /\/VRI <<\n\/([0-9A-F]{40}) <</.exec(dss);
  if (!vri) throw notOurs('no VRI entry');
  const stream = (n: number): Uint8Array => {
    const head = `\n${n} 0 obj\n<< /Length `;
    const at = tail.indexOf(head);
    if (at < 0) throw notOurs(`object ${n} is missing`);
    const length = /^(\d+) >>\nstream\n/.exec(tail.slice(at + head.length, at + head.length + 40));
    if (!length) throw notOurs(`object ${n} is not a plain stream`);
    const start = signedEnd + at + head.length + length[0].length;
    return bytes.slice(start, start + Number(length[1]));
  };
  let data: ValidationData;
  try {
    data = { certs: list('Certs').map(stream), ocsps: list('OCSPs').map(stream), crls: list('CRLs').map(stream) };
  } catch (error) {
    throw error instanceof SealError ? error : notOurs('its items cannot be read');
  }
  let expected: Uint8Array;
  try {
    expected = dssUpdate(revisionBytes, data, vri[1]);
  } catch {
    throw notOurs('it cannot be written again from what it carries');
  }
  const actual = bytes.subarray(signedEnd);
  if (expected.length !== actual.length || expected.some((b, i) => b !== actual[i])) throw notOurs('it is not exactly the update its items make');
  return { data, vriKey: vri[1] };
}

/** The VRI key of a signature: the upper-case SHA-1 of its /Contents, as written, padding included. */
export async function vriKeyOf(contents: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-1', new Uint8Array(contents)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}
