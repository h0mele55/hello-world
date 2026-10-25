import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PDFDict, PDFDocument, PDFName, PDFRawStream, PDFString, rgb, StandardFonts, decodePDFRawStream } from '@cantoo/pdf-lib';
import { chromium } from '@playwright/test';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { stampPdf } from '@/lib/stamp';
import type { StampFields } from '@/lib/stamp-fields';
import { renderReport } from '../fixtures/pdf/render';
import { REPORTS, type ReportFixture } from '../fixtures/pdf/reports';

/**
 * How each tampered file is made. Every case starts from a COMPLETE version:
 * the anchored original and its stamped, anchored distribution copy. The
 * tools are the ones a person would reach for: an incremental save (what PDF
 * editors write), a re-render of the report with the anchor reference kept,
 * qpdf, and Chromium's print to PDF.
 */

export const reportFixture = (file: string): ReportFixture => {
  const report = REPORTS.find((r) => r.file === file);
  if (!report) throw new Error(`no fixture ${file}`);
  return report;
};

/** An incremental update, as a PDF editor saves: the given file stays the prefix. */
export async function incremental(bytes: Uint8Array, edit: (doc: PDFDocument) => void | Promise<void>): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { forIncrementalUpdate: true, updateMetadata: false });
  await edit(doc);
  return doc.commit();
}

const infoOf = (doc: PDFDocument) => doc.context.lookup(doc.context.trailerInfo.Info, PDFDict);

interface TextRun {
  str: string;
  transform: number[];
  width: number;
}

/** Each page's text runs, with their positions, as pdf.js reads them. */
async function textRuns(bytes: Uint8Array): Promise<TextRun[][]> {
  const task = pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 });
  try {
    const doc = await task.promise;
    const pages: TextRun[][] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const { items } = await (await doc.getPage(n)).getTextContent();
      pages.push(items.filter((item) => 'str' in item).map((item) => item as unknown as TextRun));
    }
    return pages;
  } finally {
    await task.destroy();
  }
}

/** One byte changed where no reader looks: the binary marker comment on the file's second line. */
export function oneByteFlip(copy: Uint8Array): Uint8Array {
  const flipped = copy.slice();
  const at = flipped.indexOf(0x0a) + 2; // "%" then the first marker byte
  if (flipped[at - 1] !== 0x25 || flipped[at] < 0x80) throw new Error('no binary marker comment to flip');
  flipped[at] ^= 0x01;
  return flipped;
}

/** Only the title in the Info dictionary changes. */
export const metadataOnly = (copy: Uint8Array) => incremental(copy, (doc) => infoOf(doc).set(PDFName.of('Title'), PDFString.of('Annual report (final)')));

/** The report re-rendered with one opinion sentence edited, keeping the anchor reference it carried. */
export async function editedOpinion(stamp: StampFields): Promise<Uint8Array> {
  const report = reportFixture('en-unmodified.pdf');
  const opinion = report.opinion.map((p) => p.replace('present fairly, in all material respects', 'present fairly, in some respects'));
  if (opinion.join() === report.opinion.join()) throw new Error('the edit changed nothing');
  return stampPdf(new Uint8Array(await renderReport({ ...report, opinion })), stamp);
}

/** The report re-rendered as a qualified opinion, same words, keeping the anchor reference. */
export async function opinionTypeFlip(stamp: StampFields): Promise<Uint8Array> {
  const report = reportFixture('en-unmodified.pdf');
  const flipped = { ...report, headings: { opinion: 'Qualified Opinion', basis: 'Basis for Qualified Opinion' } };
  return stampPdf(new Uint8Array(await renderReport(flipped)), stamp);
}

function withTempFiles<T>(run: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tamper-'));
  try {
    return run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** A full re-save by another tool: qpdf rewrites every object and merges the incremental updates. */
export function qpdfResave(copy: Uint8Array): Uint8Array {
  return withTempFiles((dir) => {
    fs.writeFileSync(path.join(dir, 'in.pdf'), copy);
    execFileSync('qpdf', [path.join(dir, 'in.pdf'), path.join(dir, 'out.pdf')]);
    return new Uint8Array(fs.readFileSync(path.join(dir, 'out.pdf')));
  });
}

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** What a reader gets by printing the report to PDF from Chromium: the same words, none of the file. */
export async function printToPdf(copy: Uint8Array): Promise<Uint8Array> {
  const pages = (await textRuns(copy)).map((runs) =>
    runs
      .filter((run) => run.str.trim() !== '')
      .map((run) => `<span style="left:${run.transform[4]}pt;bottom:${run.transform[5]}pt">${escapeHtml(run.str)}</span>`)
      .join(''),
  );
  const html = `<!doctype html><meta charset="utf-8"><style>@page{size:595.28pt 841.89pt;margin:0}body{margin:0;font:10pt sans-serif}.p{position:relative;width:595.28pt;height:841.89pt;page-break-after:always}span{position:absolute;white-space:pre}</style>${pages.map((p) => `<div class="p">${p}</div>`).join('')}`;
  const browser = await chromium.launch(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {});
  try {
    const page = await browser.newPage();
    await page.setContent(html);
    return new Uint8Array(await page.pdf({ preferCSSPageSize: true }));
  } finally {
    await browser.close();
  }
}

/** A later incremental update that appends a page saying the report is withdrawn. */
export const appendedUpdate = (copy: Uint8Array) =>
  incremental(copy, async (doc) => {
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.addPage([595.28, 841.89]).drawText('This report has been withdrawn.', { x: 72, y: 760, size: 12, font });
  });

/**
 * White text on the white page, on the baseline of the opinion's last line:
 * invisible to a reader, read by every text extractor.
 */
export async function hiddenTextOverlay(copy: Uint8Array): Promise<Uint8Array> {
  const pages = await textRuns(copy);
  const page = pages.findIndex((runs) => runs.some((run) => run.str.includes('European Union.')));
  if (page < 0) throw new Error("the opinion's last line was not found");
  const last = pages[page].filter((run) => run.str.includes('European Union.')).at(-1)!;
  return incremental(copy, async (pdf) => {
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    pdf.getPage(page).drawText('Subject to going concern.', { x: last.transform[4] + last.width + 3, y: last.transform[5], size: 4, font, color: rgb(1, 1, 1) });
  });
}

/** The XMP packet removed; the Info keys still carry the stamp. */
export const strippedXmp = (copy: Uint8Array) =>
  incremental(copy, (doc) => {
    doc.catalog.delete(PDFName.of('Metadata'));
  });

/** The XMP packet and the Info keys removed: no anchor reference left at all. */
export const strippedStamp = (copy: Uint8Array) =>
  incremental(copy, (doc) => {
    doc.catalog.delete(PDFName.of('Metadata'));
    const info = infoOf(doc);
    for (const key of info.keys()) if (key.decodeText().startsWith('AuditAnchor')) info.delete(key);
  });

/** Only the XMP is rewritten to name another record; the Info keys are left as they were. */
export const forgedXmpOnly = (copy: Uint8Array, from: string, to: string) =>
  incremental(copy, (doc) => {
    const stream = doc.catalog.lookup(PDFName.of('Metadata'));
    if (!(stream instanceof PDFRawStream)) throw new Error('no XMP stream');
    const xmp = new TextDecoder().decode(decodePDFRawStream(stream).decode());
    if (!xmp.includes(from)) throw new Error('the XMP does not name the record');
    const forged = doc.context.stream(new TextEncoder().encode(xmp.replaceAll(from, to)), { Type: 'Metadata', Subtype: 'XML' });
    doc.catalog.set(PDFName.of('Metadata'), doc.context.register(forged));
  });
