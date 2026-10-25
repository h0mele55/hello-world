import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { docHashOf, familyIdOf, opinionCommitmentOf } from '@/lib/commitments';
import { buildManifest, manifestHashOf } from '@/lib/manifest';
import { locateOpinion } from '@/lib/opinion/locate';
import { dropRunningLines, normaliseText } from '@/lib/opinion/normalise';
import { parsePdf, type ParsedPdf } from '@/lib/pdf/parse';
import { GOLDEN, MANIFEST_SALT, OPINION_SALT, SECRET } from '../fixtures/pdf/golden';
import { REPORTS } from '../fixtures/pdf/reports';

/**
 * Golden values for the synthetic corpus. CI runs this file on Ubuntu and
 * Windows: the same file must give the same hashes everywhere, or a verifier
 * on another machine would reject a genuine report. The salts and secret are
 * fixed test values; real ones come from the CSPRNG.
 *
 * Regenerating a fixture changes its docHash. A change to the parser,
 * normaliser or commitments that moves any other value here changes what a
 * stored commitment means, and needs a new normaliser or manifest version.
 */
const linesOf = (pdf: ParsedPdf) => dropRunningLines(pdf.pages.map((page) => page.lines.map((line) => line.text)));

describe('golden hashes for the synthetic corpus', () => {
  it('covers every fixture', () => {
    expect(Object.keys(GOLDEN).sort()).toEqual(REPORTS.map((r) => r.file).sort());
  });

  for (const report of REPORTS) {
    it(report.file, async () => {
      const bytes = fs.readFileSync(path.join(import.meta.dirname, '..', 'fixtures', 'pdf', report.file));
      const golden = GOLDEN[report.file];
      const docHash = docHashOf(bytes);
      expect(docHash).toBe(golden.docHash);

      const parsed = await parsePdf(bytes);
      if (!parsed.ok) throw new Error(`refused: ${parsed.reason}`);
      expect(parsed.pdf.flags).toEqual({ signed: report.render?.signed === true, javascript: false, embeddedFiles: false, xfa: false, editProtected: false });

      const located = locateOpinion(linesOf(parsed.pdf));
      if ('notFound' in report.expect) {
        expect(located).toEqual({ status: 'NOT_FOUND', reason: report.expect.notFound });
        return;
      }
      if (located.status !== 'FOUND') throw new Error(`not found: ${located.reason}`);
      expect(located.type).toBe(report.expect.type);
      expect(located.language).toBe(report.language);
      // Exactly the paragraphs that were rendered: nothing lost at line
      // breaks or page breaks, no running header or footer let in.
      expect(located.text).toBe(normaliseText(report.opinion.join(' ')));

      const opinionCommitment = opinionCommitmentOf({ salt: OPINION_SALT, type: located.type, text: located.text });
      expect(opinionCommitment).toBe(golden.opinionCommitment);
      const manifest = buildManifest({
        familyId: familyIdOf(SECRET, { registrationNumber: '123456789', periodEnd: '2025-12-31', reportType: 'STANDALONE', engagementRef: report.file }),
        version: 1,
        reasonCode: 'INITIAL',
        docHash,
        pageCount: parsed.pdf.pageCount,
        reportDate: '2026-03-20',
        opinionType: located.type,
        opinionCommitment,
        manifestSalt: MANIFEST_SALT,
      });
      expect(manifestHashOf(manifest)).toBe(golden.manifestHash);
    });
  }

  it('parses the same file to the same result twice', async () => {
    const bytes = fs.readFileSync(path.join(import.meta.dirname, '..', 'fixtures', 'pdf', 'bg-qualified.pdf'));
    const [a, b] = await Promise.all([parsePdf(bytes), parsePdf(bytes)]);
    expect(a).toEqual(b);
  });
});
