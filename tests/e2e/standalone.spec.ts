import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test, type Request } from '@playwright/test';
import { runTag, uniquePdf } from './helpers';

/**
 * dist/verifier.html, opened straight from disk with no server at all
 * (rule 5): it reaches a verdict through the two RPC endpoints baked into it,
 * declares a CSP that allows nothing else, and sends no part of the file.
 * CI builds it (`npm run build:verifier`) against the local Anvil registry,
 * whose deployment it finalizes first: an unfinalized registry is refused.
 */

const HTML = path.join(process.cwd(), 'dist', 'verifier.html');
const RPC_URL = process.env.LOCAL_RPC_URL ?? 'http://127.0.0.1:8545';

test.skip(!fs.existsSync(HTML) && !process.env.CI, 'run `npm run build:verifier` first');

test('the single-file verifier works from disk, connects only to its endpoints and uploads nothing', async ({ page }) => {
  const requests: Request[] = [];
  const refused: string[] = [];
  page.on('request', (request) => requests.push(request));
  page.on('console', (message) => {
    if (message.type() === 'error') refused.push(message.text());
  });
  await page.goto(pathToFileURL(HTML).href);

  const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  expect(csp).toContain("default-src 'none'");
  expect(csp).toContain(`connect-src ${new URL(RPC_URL).origin}`);
  expect(csp).not.toContain('unsafe-inline');

  const file = uniquePdf('en-adverse.pdf', runTag());
  await page.getByTestId('verify-file').setInputFiles({ name: 'report.pdf', mimeType: 'application/pdf', buffer: file });
  await expect(page.getByTestId('verdict')).toHaveAttribute('data-kind', 'NOT_REGISTERED', { timeout: 30_000 });
  // Read as a PDF (its own CSP did not block pdf.js's worker), and found to carry no anchor.
  await expect(page.getByTestId('verdict-body')).toContainText('carries no anchor reference');
  await expect(page.getByTestId('file-hash')).toHaveText(/^0x[0-9a-f]{64}$/);
  expect(refused).toEqual([]);

  const network = requests.filter((r) => r.url().startsWith('http'));
  expect(network.length).toBeGreaterThan(0);
  for (const request of network) {
    expect(new URL(request.url()).origin, request.url()).toBe(new URL(RPC_URL).origin);
    expect(request.postDataBuffer()?.includes(Buffer.from('%PDF')) ?? false, request.url()).toBe(false);
  }

  await page.getByTestId('locale-bg').click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Проверка на одиторски доклад');
  await expect(page.getByRole('heading', { level: 2 })).toHaveText('Не е регистриран');
});
