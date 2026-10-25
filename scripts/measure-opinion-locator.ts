/**
 * Measures the opinion locator against the public corpus fetched by
 * scripts/fetch-public-corpus.mjs. The Phase 2 exit gate: the opinion is found
 * in at least 90% of digital PDFs, and every miss is reported as NOT_FOUND,
 * never as a wrong passage.
 *
 *   npx tsx scripts/measure-opinion-locator.ts
 *
 * Exits non-zero when any report is located WRONGLY (wrong type, or a passage
 * that does not start where the corpus list says the opinion starts). A miss
 * is counted against the hit rate but is not an error: a person types the
 * opinion in instead.
 */
import fs from 'node:fs';
import path from 'node:path';
import { locateOpinion } from '../src/lib/opinion/locate';
import { dropRunningLines, normaliseText } from '../src/lib/opinion/normalise';
import type { OpinionType } from '../src/lib/opinion/types';
import { parsePdf } from '../src/lib/pdf/parse';

interface CorpusEntry {
  id: string;
  language: 'en' | 'bg';
  /** The opinion type printed in the report, or null when the report is not expected to be locatable. */
  opinionType: OpinionType | null;
  /** The first words of the opinion paragraph, as a person read them. */
  opinionStartsWith?: string;
  /** How many independent auditor's reports the PDF holds. */
  reportsInFile: number;
}

const ROOT = path.resolve(import.meta.dirname, '..');
const CACHE = path.join(ROOT, '.cache', 'public-corpus');

async function main() {
  const entries: CorpusEntry[] = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'public-corpus.json'), 'utf8')).reports;
  let found = 0;
  let digital = 0;
  let wrong = 0;
  let singleFound = 0;
  let singleDigital = 0;
  const rows: string[] = [];
  for (const entry of entries) {
    const file = path.join(CACHE, `${entry.id}.pdf`);
    if (!fs.existsSync(file)) {
      rows.push(`${entry.id.padEnd(28)} not fetched`);
      continue;
    }
    const parsed = await parsePdf(fs.readFileSync(file));
    if (!parsed.ok) {
      rows.push(`${entry.id.padEnd(28)} refused ${parsed.reason}`);
      continue;
    }
    if (parsed.pdf.textChars === 0) {
      rows.push(`${entry.id.padEnd(28)} no text layer (not counted)`);
      continue;
    }
    digital++;
    if (entry.reportsInFile === 1) singleDigital++;
    const located = locateOpinion(dropRunningLines(parsed.pdf.pages.map((p) => p.lines.map((l) => l.text))));
    if (located.status === 'NOT_FOUND') {
      rows.push(`${entry.id.padEnd(28)} miss    ${located.reason}`);
      continue;
    }
    const startsRight = !entry.opinionStartsWith || located.text.startsWith(normaliseText(entry.opinionStartsWith));
    if (located.type !== entry.opinionType || !startsRight) {
      wrong++;
      rows.push(`${entry.id.padEnd(28)} WRONG   found ${located.type} "${located.text.slice(0, 60)}…", expected ${entry.opinionType}`);
      continue;
    }
    found++;
    if (entry.reportsInFile === 1) singleFound++;
    rows.push(`${entry.id.padEnd(28)} found   ${located.type} pages ${located.pageRange.join('-')}`);
  }
  console.log(rows.join('\n'));
  const pct = (n: number, of: number) => (of === 0 ? '0.0' : ((100 * n) / of).toFixed(1));
  console.log(`\nFound ${found} of ${digital} digital reports (${pct(found, digital)}%); wrong: ${wrong}. Gate: at least 90% and none wrong.`);
  console.log(`PDFs holding one auditor's report: found ${singleFound} of ${singleDigital} (${pct(singleFound, singleDigital)}%).`);
  if (wrong > 0) process.exitCode = 1;
}

main();
