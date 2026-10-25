import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { expect, test } from '@playwright/test';
import { GOLDEN, OPINION_SALT } from '../fixtures/pdf/golden';
import { REPORTS } from '../fixtures/pdf/reports';

/**
 * The Phase 2 golden values, recomputed in a real browser by the verifier's
 * own code (src/lib/verify-core) and pdf.js's browser build. A file the
 * server committed to must give the same docHash and opinion commitment in a
 * recipient's browser (Phase 4 hardening: one normaliser serves both).
 */

const ROOT = process.cwd();
const ORIGIN = 'http://verify-core.test';
let bundle = '';

test.beforeAll(async () => {
  const result = await build({
    entryPoints: [path.join(ROOT, 'tests', 'browser', 'verify-core-entry.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
    logLevel: 'silent',
  });
  bundle = result.outputFiles[0].text;
});

test('every fixture gives its golden docHash and opinion commitment in the browser', async ({ page }) => {
  const worker = fs.readFileSync(path.join(ROOT, 'node_modules', 'pdfjs-dist', 'build', 'pdf.worker.min.mjs'));
  await page.route(`${ORIGIN}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><script type="module" src="/verify-core.js"></script>' });
    if (url.pathname === '/verify-core.js') return route.fulfill({ contentType: 'text/javascript', body: bundle });
    if (url.pathname === '/pdf.worker.min.mjs') return route.fulfill({ contentType: 'text/javascript', body: worker });
    const fixture = url.pathname.match(/^\/fixtures\/([\w.-]+\.pdf)$/)?.[1];
    if (fixture) return route.fulfill({ contentType: 'application/pdf', body: fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'pdf', fixture)) });
    return route.fulfill({ status: 404 });
  });
  await page.goto(`${ORIGIN}/`);
  await page.waitForFunction(() => 'verifyCoreGolden' in window);

  for (const report of REPORTS) {
    const result = await page.evaluate(
      async ({ file, salt }) => {
        const bytes = new Uint8Array(await (await fetch(`/fixtures/${file}`)).arrayBuffer());
        const run = (window as unknown as { verifyCoreGolden: (b: Uint8Array, s: Uint8Array) => Promise<Record<string, string>> }).verifyCoreGolden;
        return run(bytes, new Uint8Array(salt));
      },
      { file: report.file, salt: [...OPINION_SALT] },
    );
    const golden = GOLDEN[report.file];
    expect(result.docHash, report.file).toBe(golden.docHash);
    if ('notFound' in report.expect) {
      expect(result.notFound, report.file).toBe(report.expect.notFound);
    } else {
      expect(result.type, report.file).toBe(report.expect.type);
      expect(result.opinionCommitment, report.file).toBe(golden.opinionCommitment);
    }
  }
});
