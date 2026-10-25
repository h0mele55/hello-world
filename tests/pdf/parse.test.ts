import fs from 'node:fs';
import path from 'node:path';
import PDFDocument from 'pdfkit';
import { describe, expect, it } from 'vitest';
import { locateOpinion } from '@/lib/opinion/locate';
import { dropRunningLines, joinLines } from '@/lib/opinion/normalise';
import { parsePdf, PDF_LIMITS } from '@/lib/pdf/parse';
import { onePage } from '../helpers/minimal-pdf';

const fixture = (name: string) => fs.readFileSync(path.join(import.meta.dirname, '..', 'fixtures', 'pdf', name));

function pdfkit(options: PDFKit.PDFDocumentOptions, draw: (doc: PDFKit.PDFDocument) => void): Promise<Buffer> {
  const doc = new PDFDocument(options);
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
  draw(doc);
  doc.end();
  return done;
}

describe('parsePdf', () => {
  it('returns per-page lines with positions, the Info dictionary and the page count', async () => {
    const result = await parsePdf(fixture('en-unmodified.pdf'));
    if (!result.ok) throw new Error(result.reason);
    expect(result.pdf.pageCount).toBe(1);
    expect(result.pdf.info.Title).toBe("INDEPENDENT AUDITOR'S REPORT");
    const first = result.pdf.pages[0].lines[0];
    expect(first.text).toBe("Example Manufacturing AD · Independent auditor's report · 31 December 2025");
    expect(first.y).toBeGreaterThan(result.pdf.pages[0].lines[1].y);
    expect(result.pdf.textChars).toBeGreaterThan(1000);
  });

  it('reads a two-column page column by column, between full-width lines', async () => {
    const left = 'We have audited the financial statements of Example plc. In our opinion, the financial statements give a true and fair view of the state of the company’s affairs.';
    const right = 'We conducted our audit in accordance with International Standards on Auditing. We believe that the audit evidence we have obtained is sufficient and appropriate.';
    const bytes = await pdfkit({ size: 'A4', margin: 0 }, (doc) => {
      doc.font('Helvetica-Bold').fontSize(12).text("INDEPENDENT AUDITOR'S REPORT TO THE MEMBERS OF EXAMPLE PLC", 50, 60, { width: 495 });
      doc.text('Opinion', 50, 100, { width: 230 });
      doc.text('Basis for opinion', 315, 100, { width: 230 });
      doc.font('Helvetica').fontSize(10).text(left, 50, 120, { width: 230 });
      doc.text(right, 315, 120, { width: 230 });
      doc.text('Key audit matters are those matters that, in our professional judgement, were of most significance in our audit.', 50, 220, { width: 495 });
    });
    const result = await parsePdf(bytes);
    if (!result.ok) throw new Error(result.reason);
    const texts = result.pdf.pages[0].lines.map((l) => l.text);
    expect(texts[0]).toBe("INDEPENDENT AUDITOR'S REPORT TO THE MEMBERS OF EXAMPLE PLC");
    const opinion = texts.indexOf('Opinion');
    const basis = texts.indexOf('Basis for opinion');
    // The whole left column comes before the right column, and every line belongs to one column.
    expect(opinion).toBe(1);
    expect(basis).toBeGreaterThan(opinion + 2);
    expect(joinLines(texts.slice(opinion + 1, basis))).toBe(left);
    expect(texts.at(-1)).toMatch(/^Key audit matters are those matters/);
    expect(locateOpinion(dropRunningLines([texts]))).toMatchObject({ status: 'FOUND', type: 'UNMODIFIED', text: left });
  });

  it('refuses a file that does not start with %PDF-', async () => {
    expect(await parsePdf(new TextEncoder().encode('<html>not a pdf</html>'))).toEqual({ ok: false, reason: 'NOT_A_PDF' });
    expect(await parsePdf(Buffer.concat([Buffer.from(' '), fixture('en-unmodified.pdf')]))).toEqual({ ok: false, reason: 'NOT_A_PDF' });
    expect(await parsePdf(new Uint8Array(0))).toEqual({ ok: false, reason: 'NOT_A_PDF' });
  });

  it('refuses a file over 25 MB before starting the parser', async () => {
    const big = Buffer.alloc(PDF_LIMITS.maxBytes + 1, 0x20);
    big.write('%PDF-1.7', 0, 'latin1');
    expect(await parsePdf(big)).toEqual({ ok: false, reason: 'TOO_LARGE' });
  });

  it('refuses a cut-off file instead of reading what survives', async () => {
    const bytes = fixture('en-unmodified.pdf');
    for (const keep of [0.25, 0.5, 0.9]) {
      expect(await parsePdf(bytes.subarray(0, Math.floor(bytes.length * keep)))).toEqual({ ok: false, reason: 'TRUNCATED' });
    }
  });

  it('refuses more than 500 pages', async () => {
    const bytes = await pdfkit({ autoFirstPage: false }, (doc) => {
      for (let i = 0; i < PDF_LIMITS.maxPages + 1; i++) doc.addPage({ size: [100, 100] });
    });
    expect(await parsePdf(bytes)).toEqual({ ok: false, reason: 'TOO_MANY_PAGES' });
  });

  it('refuses a file that needs a password to open', async () => {
    const userPassword = await pdfkit({ userPassword: 'secret', ownerPassword: 'owner' }, (doc) => doc.text('Opinion'));
    expect(await parsePdf(userPassword)).toEqual({ ok: false, reason: 'ENCRYPTED' });
  });

  it('reads an edit-protected file and flags it, so it can be anchored without stamping (#74)', async () => {
    const ownerOnly = await pdfkit({ ownerPassword: 'owner', permissions: { modifying: false } }, (doc) => doc.text('Opinion'));
    const result = await parsePdf(ownerOnly);
    if (!result.ok) throw new Error(result.reason);
    expect(result.pdf.flags.editProtected).toBe(true);
    expect(result.pdf.pages[0].lines[0].text).toBe('Opinion');
  });

  it('flags JavaScript and embedded files', async () => {
    const js = onePage('BT /F1 12 Tf 72 700 Td (Opinion) Tj ET', '/OpenAction << /S /JavaScript /JS (app.alert(1)) >>');
    const jsResult = await parsePdf(js);
    if (!jsResult.ok) throw new Error(jsResult.reason);
    expect(jsResult.pdf.flags).toMatchObject({ javascript: true, signed: false });

    const attached = await pdfkit({}, (doc) => {
      doc.text('Report');
      doc.file(Buffer.from('payload'), { name: 'payload.txt' });
    });
    const attachedResult = await parsePdf(attached);
    if (!attachedResult.ok) throw new Error(attachedResult.reason);
    expect(attachedResult.pdf.flags.embeddedFiles).toBe(true);
  });

  it('kills the parser at the time limit', async () => {
    expect(await parsePdf(fixture('en-unmodified.pdf'), { timeoutMs: 1 })).toEqual({ ok: false, reason: 'TIMEOUT' });
  });

  it('reports a parser that runs out of memory as RESOURCE_LIMIT', async () => {
    expect(await parsePdf(fixture('en-unmodified.pdf'), { heapMb: 2 })).toEqual({ ok: false, reason: 'RESOURCE_LIMIT' });
  });

  it('refuses a file with more text than the limit', async () => {
    expect(await parsePdf(fixture('en-unmodified.pdf'), { maxTextChars: 100 })).toEqual({ ok: false, reason: 'TOO_MUCH_TEXT' });
  });
});
