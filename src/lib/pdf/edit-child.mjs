// Runs in a child process that src/lib/pdf/isolated.ts forks (#154): the only
// place a stored PDF is loaded with pdf-lib. pdf-lib inflates every object
// stream it finds, referenced or not, so a file of a few hundred kilobytes can
// ask for gigabytes; here it can at worst exhaust this process, which the
// parent caps and kills. It receives one file and one edit over IPC, answers
// with the edited bytes or a named refusal, and exits. Plain JavaScript, so
// Node runs it with no loader; no filesystem, no network, no logging (its
// stdio is closed), and an empty environment.
//
// Both edits are incremental updates: the file sent is the answer's prefix,
// which the parent checks. Signing and timestamping stay in the worker, which
// needs only the digest of what this writes.
import {
  decodePDFRawStream,
  EncryptedPDFError,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFString,
} from '@cantoo/pdf-lib';

async function open(bytes) {
  try {
    const doc = await PDFDocument.load(bytes, { forIncrementalUpdate: true, updateMetadata: false });
    return doc.isEncrypted ? { refusal: 'ENCRYPTED' } : { doc };
  } catch (error) {
    return { refusal: error instanceof EncryptedPDFError ? 'ENCRYPTED' : 'UNREADABLE' };
  }
}

/** The document's current XMP packet as text, or null when absent or unreadable. */
function existingXmp(doc) {
  try {
    const stream = doc.catalog.lookup(PDFName.of('Metadata'));
    if (!(stream instanceof PDFRawStream)) return null;
    return new TextDecoder('utf-8', { fatal: true }).decode(decodePDFRawStream(stream).decode());
  } catch {
    return null;
  }
}

/** The trailer's Info dictionary, created when the document has none. */
function infoDictOf(doc) {
  const existing = doc.context.lookup(doc.context.trailerInfo.Info);
  if (existing instanceof PDFDict) return existing;
  const created = doc.context.obj({});
  doc.context.trailerInfo.Info = doc.context.register(created);
  return created;
}

/** The anchor stamp (src/lib/stamp.ts says what it holds), in the XMP and the Info dictionary. */
async function stamp(doc, edit) {
  const xmp = existingXmp(doc);
  const info = infoDictOf(doc);
  const alreadyStamped = (xmp?.includes(edit.namespace) ?? false) || info.keys().some((key) => key.decodeText().startsWith(edit.infoKeyPrefix));
  if (alreadyStamped) return { ok: false, code: 'ALREADY_STAMPED' };
  // Keep the document's own XMP when it can be extended in one place;
  // otherwise write a fresh packet (the old one stays in the original bytes).
  const merged = xmp && xmp.split('</rdf:RDF>').length === 2 ? xmp.replace('</rdf:RDF>', `${edit.description}</rdf:RDF>`) : edit.freshPacket;
  const metadata = doc.context.stream(new TextEncoder().encode(merged), { Type: 'Metadata', Subtype: 'XML' });
  doc.catalog.set(PDFName.of('Metadata'), doc.context.register(metadata));
  for (const [key, value] of edit.info) info.set(PDFName.of(key), PDFString.of(value));
  return { ok: true, bytes: await doc.commit() };
}

/** The seal's signature field with placeholders for its byte range and contents (src/lib/eseal/pades.ts fills them). */
async function prepareSeal(doc, edit) {
  const ctx = doc.context;
  const byteRange = PDFArray.withContext(ctx);
  for (const n of [0, edit.placeholder, edit.placeholder, edit.placeholder]) byteRange.push(PDFNumber.of(n));
  const signature = ctx.obj({
    Type: 'Sig',
    Filter: 'Adobe.PPKLite',
    SubFilter: 'ETSI.CAdES.detached',
    ByteRange: byteRange,
    Contents: PDFHexString.of('0'.repeat(edit.contentsBytes * 2)),
    M: PDFString.of(edit.signingTime),
    Reason: PDFHexString.fromText(edit.reason),
  });
  const signatureRef = ctx.register(signature);
  if (doc.getPageCount() < 1) return { ok: false, code: 'UNREADABLE' };
  const page = doc.getPage(0);
  // An invisible signature field: the seal changes nothing a reader sees on the pages.
  const widget = ctx.obj({
    Type: 'Annot',
    Subtype: 'Widget',
    FT: 'Sig',
    T: PDFString.of(edit.fieldName),
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
  return { ok: true, bytes: await doc.commit() };
}

const EDITS = { stamp, prepareSeal };

process.once('message', async (message) => {
  let answer;
  try {
    const edit = EDITS[message?.edit?.kind];
    if (!edit) {
      answer = { ok: false, code: 'UNREADABLE' };
    } else {
      const opened = await open(new Uint8Array(message.bytes));
      answer = opened.refusal ? { ok: false, code: opened.refusal } : await edit(opened.doc, message.edit);
    }
  } catch {
    answer = { ok: false, code: 'UNREADABLE' };
  }
  process.send(answer, () => process.exit(0));
});
