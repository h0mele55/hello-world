import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument, StandardFonts } from '@cantoo/pdf-lib';
import { describe, expect, it } from 'vitest';
import { certificatePdf } from '@/lib/certificate';
import { sha256 } from '@/lib/commitments';
import { parsePdf } from '@/lib/pdf/parse';
import { checkStampedCopy, stampPdf, StampError } from '@/lib/stamp';
import { readStamp, STAMP_NAMESPACE, type StampFields } from '@/lib/stamp-fields';
import { minimalPdf } from '../helpers/minimal-pdf';

const fixture = (name: string) => new Uint8Array(fs.readFileSync(path.join(import.meta.dirname, '..', 'fixtures', 'pdf', name)));

const FIELDS: StampFields = {
  stamp: 1,
  chainId: 11155111,
  contract: '0x87Ba96d1d48e280429A8ead1059334C34507c31F',
  recordId: `0x${'1a'.repeat(32)}`,
  txHash: `0x${'2b'.repeat(32)}`,
  blockNumber: 9876543,
  familyId: `0x${'3c'.repeat(32)}`,
  version: 1,
  verifyUrl: 'https://anchor.example/verify',
  opinionType: 'UNMODIFIED',
  opinionSalt: `0x${'4d'.repeat(32)}`,
  norm: 1,
};

async function stampCode(promise: Promise<unknown>): Promise<string | null> {
  return promise.then(
    () => null,
    (error: unknown) => (error instanceof StampError ? error.code : String(error)),
  );
}

describe('stamping a distribution copy', () => {
  it.each(['en-unmodified.pdf', 'en-qualified.pdf', 'bg-adverse.pdf', 'bg-disclaimer.pdf'])('%s: the copy begins with the original and passes the check', async (name) => {
    const original = fixture(name);
    const stamped = await stampPdf(original, FIELDS);
    expect(Buffer.from(stamped.subarray(0, original.length)).equals(Buffer.from(original))).toBe(true);
    const check = await checkStampedCopy(original, stamped, FIELDS);
    expect(check).toEqual({ ok: true, docHash: sha256(stamped) });
  });

  it('is deterministic, so a retry produces the same copy', async () => {
    const original = fixture('en-unmodified.pdf');
    const [a, b] = await Promise.all([stampPdf(original, FIELDS), stampPdf(original, FIELDS)]);
    expect(sha256(a)).toBe(sha256(b));
    expect(sha256(await stampPdf(original, { ...FIELDS, txHash: `0x${'2c'.repeat(32)}` }))).not.toBe(sha256(a));
  });

  it('writes the stamp to both XMP and Info, where the parser reads it back', async () => {
    const parsed = await parsePdf(await stampPdf(fixture('en-unmodified.pdf'), FIELDS));
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(readStamp(parsed.pdf.xmp, parsed.pdf.info)).toEqual({ status: 'FOUND', fields: FIELDS, inXmp: true, inInfo: true });
    expect(parsed.pdf.info['Custom:AuditAnchorRecordId']).toBe(FIELDS.recordId);
  });

  it("keeps the document's own XMP and adds a description beside it", async () => {
    const xmp = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:format>application/pdf</dc:format></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
    const content = 'BT /F1 12 Tf 72 720 Td (Independent auditor report) Tj ET';
    const original = new Uint8Array(
      minimalPdf({
        objects: [
          '<< /Type /Catalog /Pages 2 0 R /Metadata 6 0 R >>',
          '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
          '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
          `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
          '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
          `<< /Type /Metadata /Subtype /XML /Length ${Buffer.byteLength(xmp)} >>\nstream\n${xmp}\nendstream`,
        ],
      }),
    );
    const stamped = await stampPdf(original, FIELDS);
    const parsed = await parsePdf(stamped);
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(parsed.pdf.xmp).toContain('<dc:format>application/pdf</dc:format>');
    expect(parsed.pdf.xmp).toContain(STAMP_NAMESPACE);
    expect(await checkStampedCopy(original, stamped, FIELDS)).toMatchObject({ ok: true });
  });

  it('refuses a file that already carries a stamp', async () => {
    const stamped = await stampPdf(fixture('en-unmodified.pdf'), FIELDS);
    expect(await stampCode(stampPdf(stamped, { ...FIELDS, recordId: `0x${'9f'.repeat(32)}` }))).toBe('ALREADY_STAMPED');
  });

  it('refuses an encrypted file', async () => {
    const original = new Uint8Array(
      minimalPdf({
        objects: [
          '<< /Type /Catalog /Pages 2 0 R >>',
          '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
          '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>',
          `<< /Filter /Standard /V 1 /R 2 /O <${'00'.repeat(32)}> /U <${'00'.repeat(32)}> /P -44 >>`,
        ],
        trailer: `/Encrypt 4 0 R /ID [<${'11'.repeat(16)}> <${'11'.repeat(16)}>]`,
      }),
    );
    expect(['ENCRYPTED', 'UNREADABLE']).toContain(await stampCode(stampPdf(original, FIELDS)));
  });

  it('fails the check when the stamp names another record, or the pages changed after stamping', async () => {
    const original = fixture('en-qualified.pdf');
    const stamped = await stampPdf(original, FIELDS);
    expect(await checkStampedCopy(original, stamped, { ...FIELDS, blockNumber: 1 })).toEqual({ ok: false, reason: 'STAMP_MISMATCH' });

    // A later incremental update that writes on the page: still begins with
    // the original and still carries the stamp, but the text is not the same.
    const doc = await PDFDocument.load(stamped, { forIncrementalUpdate: true, updateMetadata: false });
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.getPage(0).drawText('Opinion withdrawn', { x: 72, y: 100, size: 12, font });
    const tampered = await doc.commit();
    expect(await checkStampedCopy(original, tampered, FIELDS)).toEqual({ ok: false, reason: 'TEXT_CHANGED' });

    expect(await checkStampedCopy(original, original, FIELDS)).toEqual({ ok: false, reason: 'NOT_INCREMENTAL' });
    expect(await checkStampedCopy(fixture('en-unmodified.pdf'), stamped, FIELDS)).toEqual({ ok: false, reason: 'NOT_INCREMENTAL' });
  });
});

describe('the verification certificate', () => {
  it('is one readable page naming the record, the document hash and the verify URL', async () => {
    const certificate = await certificatePdf({
      version: 3,
      docHash: `0x${'ab'.repeat(32)}`,
      recordId: `0x${'cd'.repeat(32)}`,
      familyId: `0x${'ef'.repeat(32)}`,
      chainId: 31337,
      networkName: 'Local test chain',
      contract: '0x87Ba96d1d48e280429A8ead1059334C34507c31F',
      txHash: null,
      blockNumber: 42,
      verifyUrl: 'https://anchor.example/verify',
      explorerTxUrl: null,
    });
    const parsed = await parsePdf(certificate);
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(parsed.pdf.pageCount).toBe(1);
    const text = parsed.pdf.pages[0].lines.map((line) => line.text).join('\n');
    expect(text).toContain('Verification certificate');
    expect(text).toContain('Удостоверение за проверка');
    expect(text).toContain(`0x${'cd'.repeat(32)}`);
    expect(text).toContain('https://anchor.example/verify');
    expect(text).toContain('not a legally binding record');
    expect(text).not.toContain('Transaction');
  });
});
