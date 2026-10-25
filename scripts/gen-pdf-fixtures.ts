/**
 * Renders the synthetic audit reports in tests/fixtures/pdf/reports.ts into
 * tests/fixtures/pdf/*.pdf.
 *
 *   npx tsx scripts/gen-pdf-fixtures.ts           write the PDFs
 *   npx tsx scripts/gen-pdf-fixtures.ts --check   fail if a committed PDF differs
 *
 * The output is byte-for-byte reproducible (fixed dates, a font from a pinned
 * package), so CI regenerates the corpus and compares. Only synthetic PDFs are
 * committed; real reports stay in the git-ignored cache of
 * scripts/fetch-public-corpus.mjs.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { deflateSync, crc32 } from 'node:zlib';
import PDFDocument from 'pdfkit';
import { LABELS, REPORTS, TRAILING_SECTIONS, type ReportFixture } from '../tests/fixtures/pdf/reports';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'tests', 'fixtures', 'pdf');
const require = createRequire(import.meta.url);
const FONT = require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans.ttf');
const FONT_BOLD = require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf');
const FIXED_DATE = new Date('2026-03-20T09:00:00Z');

/** A minimal greyscale PNG with faint horizontal bands, standing in for a scanned page. */
function scanPng(width: number, height: number): Buffer {
  const rows = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) {
    const offset = y * (width + 1);
    rows[offset] = 0; // filter: none
    const inTextBand = y > 80 && y % 18 < 9 && y < height - 80;
    for (let x = 0; x < width; x++) {
      const ink = inTextBand && x > 60 && x < width - 60 && (x * 7 + y * 3) % 11 < 6;
      rows[offset + 1 + x] = ink ? 70 : 245;
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // greyscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * A signature field whose dictionary has the shape a real signer writes
 * (/ByteRange, /Contents) but zero-filled contents. It exercises signature
 * detection; it is not a valid signature and nothing validates it.
 */
function addPlaceholderSignature(doc: PDFKit.PDFDocument) {
  const sig = doc.ref({
    Type: 'Sig',
    Filter: 'Adobe.PPKLite',
    SubFilter: 'adbe.pkcs7.detached',
    ByteRange: [0, 0, 0, 0],
    Contents: Buffer.alloc(512),
    M: FIXED_DATE,
    Name: new String('Synthetic Signer (fixture, not a real signature)'),
  });
  const widget = doc.ref({
    Type: 'Annot',
    Subtype: 'Widget',
    FT: 'Sig',
    F: 4,
    Rect: [0, 0, 0, 0],
    T: new String('Signature1'),
    V: sig,
    P: doc.page.dictionary,
  });
  doc.page.annotations.push(widget);
  // pdfkit owns the AcroForm and ends it in doc.end().
  doc.font('body').initForm();
  const acroForm = (doc as unknown as { _root: { data: { AcroForm: { data: { Fields: unknown[]; SigFlags?: number } } } } })._root.data.AcroForm;
  acroForm.data.Fields.push(widget);
  acroForm.data.SigFlags = 3;
  // pdfkit ends only fields with kids; a leaf widget is ours to end.
  widget.end(undefined);
  sig.end(undefined);
}

function render(report: ReportFixture): Promise<Buffer> {
  const labels = LABELS[report.language];
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 72, bottom: 72, left: 72, right: 72 },
    bufferPages: true,
    info: { Title: labels.title, Author: 'Synthetic fixture', CreationDate: FIXED_DATE, ModDate: FIXED_DATE },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
  doc.registerFont('body', FONT);
  doc.registerFont('bold', FONT_BOLD);

  if (report.render?.scanned) {
    doc.image(scanPng(420, 600), 72, 72, { width: 451 });
    doc.end();
    return done;
  }

  const heading = (text: string, size = 11) => doc.font('bold').fontSize(size).text(text).moveDown(0.5);
  const para = (text: string) => doc.font('body').fontSize(10).text(text, { align: 'left' }).moveDown(0.7);

  heading(labels.title, 13);
  para(labels.addressee);
  for (let i = 0; i < (report.render?.preambleParagraphs ?? 0); i++) para(labels.preamble);
  heading(labels.section);
  heading(report.headings.opinion);
  report.opinion.forEach(para);
  heading(report.headings.basis);
  report.basis.forEach(para);
  for (const section of TRAILING_SECTIONS[report.language]) {
    heading(section.heading);
    para(section.text);
  }
  if (report.render?.signed) addPlaceholderSignature(doc);

  // Running header and footer on every page, drawn after the body so they
  // are positioned rather than flowed.
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const { margins } = doc.page;
    doc.page.margins = { ...margins, top: 0, bottom: 0 };
    doc.font('body').fontSize(8);
    doc.text(labels.header, 72, 40, { width: 451, lineBreak: false });
    doc.text(labels.page(i + 1, range.count), 72, doc.page.height - 50, { width: 451, lineBreak: false });
    doc.page.margins = margins;
  }
  doc.end();
  return done;
}

async function main() {
  const check = process.argv.includes('--check');
  let stale = 0;
  for (const report of REPORTS) {
    const bytes = await render(report);
    const target = path.join(OUT, report.file);
    if (check) {
      const current = fs.existsSync(target) ? fs.readFileSync(target) : null;
      if (!current || !current.equals(bytes)) {
        console.error(`${report.file} does not match its generator`);
        stale++;
      }
    } else {
      fs.writeFileSync(target, bytes);
      console.log(`wrote ${path.relative(ROOT, target)} (${bytes.length} bytes)`);
    }
  }
  if (stale > 0) {
    console.error(`Run npx tsx scripts/gen-pdf-fixtures.ts and commit the result.`);
    process.exit(1);
  }
  if (check) console.log(`${REPORTS.length} fixtures match their generator.`);
}

// A render whose 'end' never fires would leave main() pending and Node would
// exit 0 with a fixture missing.
let finished = false;
process.on('beforeExit', () => {
  if (!finished) {
    console.error('A fixture never finished rendering.');
    process.exit(1);
  }
});

main().then(() => {
  finished = true;
}, (error) => {
  console.error(error);
  process.exit(1);
});
