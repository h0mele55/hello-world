/**
 * Builds small hand-written PDFs for tests that need structures pdfkit will
 * not produce: JavaScript actions, broken cross-reference tables, absurd
 * nesting, decompression bombs. Objects are numbered from 1 in the order
 * given; the cross-reference table is computed, so offsets are right unless a
 * test breaks them on purpose.
 */
export interface MinimalPdfOptions {
  /** Raw object bodies (between "N 0 obj" and "endobj"), as strings or bytes. */
  objects: (string | Uint8Array)[];
  /** Extra entries for the trailer dictionary, e.g. "/Prev 9". Root defaults to object 1. */
  trailer?: string;
  /** Replace the computed startxref offset. */
  startxref?: number;
}

const latin1 = (s: string) => Buffer.from(s, 'latin1');

export function minimalPdf({ objects, trailer = '', startxref }: MinimalPdfOptions): Buffer {
  const parts: Buffer[] = [latin1('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n')];
  const offsets: number[] = [];
  let length = parts[0].length;
  objects.forEach((body, i) => {
    offsets.push(length);
    const chunk = Buffer.concat([latin1(`${i + 1} 0 obj\n`), typeof body === 'string' ? latin1(body) : Buffer.from(body), latin1('\nendobj\n')]);
    parts.push(chunk);
    length += chunk.length;
  });
  const xrefAt = length;
  const xref = [`xref\n0 ${objects.length + 1}\n`, '0000000000 65535 f \n', ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)].join('');
  parts.push(latin1(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${trailer} >>\nstartxref\n${startxref ?? xrefAt}\n%%EOF\n`));
  return Buffer.concat(parts);
}

/** A one-page document whose page content is `content` (an uncompressed stream). */
export function onePage(content: string, extraCatalog = ''): Buffer {
  return minimalPdf({
    objects: [
      `<< /Type /Catalog /Pages 2 0 R ${extraCatalog} >>`,
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
      `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ],
  });
}
