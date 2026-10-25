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
import path from 'node:path';
import { renderReport } from '../tests/fixtures/pdf/render';
import { REPORTS } from '../tests/fixtures/pdf/reports';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'tests', 'fixtures', 'pdf');

async function main() {
  const check = process.argv.includes('--check');
  let stale = 0;
  for (const report of REPORTS) {
    const bytes = await renderReport(report);
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
