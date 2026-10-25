import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { parsePdf, PDF_LIMITS, PDF_REFUSALS, type ParseResult } from '@/lib/pdf/parse';
import { minimalPdf, onePage } from '../helpers/minimal-pdf';

/**
 * Hostile and broken PDFs. Each must come back as a parse result, never as a
 * crash of this process or a hang, and the ones that cannot be read must be
 * refused with a reason from PDF_REFUSALS (CLAUDE.md rule 7).
 */

const fixture = (name: string) => fs.readFileSync(path.join(import.meta.dirname, '..', 'fixtures', 'pdf', name));

async function timed(bytes: Uint8Array, limits: Parameters<typeof parsePdf>[1] = {}) {
  const started = Date.now();
  const result = await parsePdf(bytes, limits);
  return { result, ms: Date.now() - started };
}

function expectRefused(result: ParseResult) {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(PDF_REFUSALS).toContain(result.reason);
}

function expectAnswered(result: ParseResult) {
  if (!result.ok) expect(PDF_REFUSALS).toContain(result.reason);
  else expect(result.pdf.pageCount).toBeGreaterThan(0);
}

/** A PDF whose page content is `inflated` bytes of drawing operators, stored deflated. */
async function decompressionBomb(inflatedBytes: number): Promise<Buffer> {
  const chunk = Buffer.alloc(1 << 20, '0 0 m\n');
  const deflate = zlib.createDeflate({ level: 9 });
  const out: Buffer[] = [];
  deflate.on('data', (c: Buffer) => out.push(c));
  const done = new Promise((resolve) => deflate.on('end', resolve));
  for (let written = 0; written < inflatedBytes; written += chunk.length) {
    if (!deflate.write(chunk)) await new Promise((resolve) => deflate.once('drain', resolve));
  }
  deflate.end();
  await done;
  const stream = Buffer.concat(out);
  return minimalPdf({
    objects: [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R >>',
      Buffer.concat([Buffer.from(`<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`), stream, Buffer.from('\nendstream')]),
    ],
  });
}

describe('malformed and hostile PDFs', () => {
  it('a file cut short, or spliced so its offsets lie', async () => {
    const bytes = fixture('en-qualified.pdf');
    for (const cut of [10, 100, 1000, Math.floor(bytes.length / 2), bytes.length - 40]) {
      expectRefused((await timed(bytes.subarray(0, cut))).result);
      // Keep the tail (trailer, startxref, %%EOF) so only the offsets are wrong.
      expectAnswered((await timed(Buffer.concat([bytes.subarray(0, cut), bytes.subarray(-300)]))).result);
    }
  });

  it('a cross-reference chain that loops back on itself', async () => {
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>',
    ];
    // The trailer follows the table, so adding /Prev leaves the table where
    // it was: /Prev then names the very table it sits under.
    const xrefAt = Number(/startxref\n(\d+)/.exec(minimalPdf({ objects }).toString('latin1'))![1]);
    const { result, ms } = await timed(minimalPdf({ objects, trailer: `/Prev ${xrefAt}` }));
    expectAnswered(result);
    expect(ms).toBeLessThan(PDF_LIMITS.timeoutMs + 5_000);
  });

  it('a page tree that contains itself', async () => {
    const { result } = await timed(minimalPdf({
      objects: ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [2 0 R 3 0 R] /Count 2 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>'],
    }));
    expectAnswered(result);
  });

  it('objects nested a hundred thousand levels deep', async () => {
    const depth = 100_000;
    const { result } = await timed(onePage('BT ET', `/Junk ${'['.repeat(depth)}${']'.repeat(depth)} /Dict ${'<< /A '.repeat(depth)}1${' >>'.repeat(depth)}`));
    expectAnswered(result);
  });

  it('garbage after a valid header', async () => {
    const noise = Buffer.alloc(200_000);
    for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761) >>> 24;
    const { result } = await timed(Buffer.concat([Buffer.from('%PDF-1.7\n'), noise, Buffer.from('\n%%EOF\n')]));
    expectRefused(result);
  });

  it('a stream that inflates to 1 GB is cut off, and the server parses the next file normally', async () => {
    const bomb = await decompressionBomb(1024 * 1024 * 1024);
    expect(bomb.length).toBeLessThan(PDF_LIMITS.maxBytes);
    const heapBefore = process.memoryUsage().heapUsed;
    const { result, ms } = await timed(bomb);
    expectRefused(result);
    expect(ms).toBeLessThan(PDF_LIMITS.timeoutMs + 5_000);
    // The bomb went off in the child; this process grew by no more than noise.
    expect(process.memoryUsage().heapUsed - heapBefore).toBeLessThan(64 * 1024 * 1024);
    expect((await parsePdf(fixture('en-unmodified.pdf'))).ok).toBe(true);
  }, 90_000);
});
