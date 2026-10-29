import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { expect, test, type Page, type Request } from '@playwright/test';
import { runTag, uniquePdf } from './helpers';

/**
 * Re-anchored records in the browser verifiers (#126). tests/e2e/reanchor-fixture.ts
 * anchored two versions of a report on a second chain standing in for Sepolia,
 * archived that registry, had the local registry's owner record the archive's
 * root, and stopped the chain. /verify (given the archive through
 * REANCHOR_ARCHIVES), dist/verifier.html and the CLI (both built with it baked
 * in) must each give the verdict the retired registry would have given, say
 * where it came from, and agree with each other, with that chain gone.
 */

const DIR = process.env.E2E_REANCHOR_DIR ?? '';
const HTML = path.join(process.cwd(), 'dist', 'verifier.html');
const RPC_URL = process.env.LOCAL_RPC_URL ?? 'http://127.0.0.1:8545';
const run = promisify(execFile);

test.skip(!process.env.REANCHOR_ARCHIVES && !process.env.CI, 'run tests/e2e/reanchor-fixture.ts and set REANCHOR_ARCHIVES and E2E_REANCHOR_DIR first');

interface Fixture {
  sourceRpcUrl: string;
  sourceChainId: number;
  sourceRegistry: string;
  sourceBlock: number;
  count: number;
  index: number;
  recordedBlock: number;
  issuer: string;
}
const fixture = (): Fixture => JSON.parse(fs.readFileSync(path.join(DIR, 'fixture.json'), 'utf8')) as Fixture;
const pdf = (name: 'v1' | 'v2') => fs.readFileSync(path.join(DIR, `${name}.pdf`));

async function upload(page: Page, name: string, buffer: Buffer) {
  await page.getByTestId('verify-file').setInputFiles({ name, mimeType: 'application/pdf', buffer });
}

/** What a verifier showed: the verdict, the record it matched, the root it went through. */
async function shown(page: Page) {
  return {
    kind: await page.getByTestId('verdict').getAttribute('data-kind'),
    matched: await page.getByTestId('record-matched').getAttribute('data-record-id'),
    latest: await page.getByTestId('record-latest').getAttribute('data-record-id').catch(() => null),
    index: Number(await page.getByTestId('reanchored').getAttribute('data-index')),
  };
}

test.beforeAll(async () => {
  // The retired chain is gone: nothing below can have read it.
  await expect(fetch(fixture().sourceRpcUrl, { method: 'POST', body: '{}' })).rejects.toThrow();
});

test('/verify checks a file from a retired chain through its archive and its root on this registry', async ({ page }) => {
  const f = fixture();
  const requests: Request[] = [];
  page.on('request', (request) => requests.push(request));
  await page.route('**/api/**', (route) => route.fulfill({ status: 503, body: 'switched off for this test' }));
  await page.goto('/verify');

  await upload(page, 'report-v1.pdf', pdf('v1'));
  await expect(page.getByTestId('verdict')).toHaveAttribute('data-kind', 'AUTHENTIC_SUPERSEDED', { timeout: 30_000 });
  const reanchored = page.getByTestId('reanchored');
  await expect(reanchored).toHaveAttribute('data-index', String(f.index));
  await expect(page.getByTestId('reanchored-body')).toContainText(f.sourceRegistry);
  await expect(page.getByTestId('reanchored-body')).toContainText(`block ${f.sourceBlock}`);
  await expect(page.getByTestId('reanchored-body')).toContainText(`recorded in block ${f.recordedBlock}`);
  await expect(page.getByTestId('record-matched-issuer')).toHaveText(f.issuer);
  // This registry holds no page for the retired family's latest.
  await expect(page.getByTestId('latest-link')).toHaveCount(0);
  const onPage = await shown(page);

  // The archive is fetched once, as a plain GET; nothing the page sends carries the file.
  const archives = requests.filter((r) => new URL(r.url()).pathname.startsWith('/reanchor/'));
  expect(archives.map((r) => [r.method(), new URL(r.url()).pathname])).toEqual([['GET', '/reanchor/0']]);
  for (const request of requests.filter((r) => r.postDataBuffer())) {
    expect(request.postDataBuffer()!.includes(Buffer.from('%PDF')), request.url()).toBe(false);
    expect(request.url().startsWith(RPC_URL), request.url()).toBe(true);
  }

  await page.getByTestId('verify-another').click();
  await upload(page, 'report-v2.pdf', pdf('v2'));
  await expect(page.getByTestId('verdict')).toHaveAttribute('data-kind', 'AUTHENTIC_LATEST', { timeout: 30_000 });
  await expect(page.getByTestId('record-matched')).toHaveAttribute('data-record-id', onPage.latest!);
  // Kept for the page's life: a second retired file costs no second fetch.
  expect(requests.filter((r) => new URL(r.url()).pathname.startsWith('/reanchor/'))).toHaveLength(1);

  // A file in neither registry is still not registered, with the archive read.
  await page.getByTestId('verify-another').click();
  await upload(page, 'other.pdf', uniquePdf('en-adverse.pdf', runTag()));
  await expect(page.getByTestId('verdict')).toHaveAttribute('data-kind', 'NOT_REGISTERED', { timeout: 30_000 });
  await expect(page.getByTestId('reanchored')).toHaveCount(0);
});

test('verifier.html, from disk, and the CLI give the same verdict as /verify, with the archive baked in', async ({ page, browser }) => {
  test.skip(!fs.existsSync(HTML) && !process.env.CI, 'run `npm run build:verifier` first');
  const f = fixture();

  const site = await browser.newPage();
  await site.goto('/verify');
  await upload(site, 'report-v1.pdf', pdf('v1'));
  await expect(site.getByTestId('verdict')).toHaveAttribute('data-kind', 'AUTHENTIC_SUPERSEDED', { timeout: 30_000 });
  const onSite = await shown(site);
  await site.close();

  const requests: Request[] = [];
  page.on('request', (request) => requests.push(request));
  await page.goto(pathToFileURL(HTML).href);
  await upload(page, 'report-v1.pdf', pdf('v1'));
  await expect(page.getByTestId('verdict')).toHaveAttribute('data-kind', 'AUTHENTIC_SUPERSEDED', { timeout: 30_000 });
  await expect(page.getByTestId('reanchored-body')).toContainText(f.sourceRegistry);
  await expect(page.getByTestId('record-matched-issuer')).toContainText(f.issuer);
  expect(await shown(page)).toEqual(onSite);
  // The archive is in the file: nothing is fetched for it, and nothing sent carries the report.
  expect(requests.filter((r) => r.url().includes('/reanchor/'))).toEqual([]);
  for (const request of requests) expect(request.postDataBuffer()?.includes(Buffer.from('%PDF')) ?? false, request.url()).toBe(false);

  await page.getByTestId('locale-bg').click();
  await expect(page.getByTestId('reanchored').getByRole('heading')).toHaveText('Пренесен от спряна мрежа');

  const file = path.join(DIR, 'v1.pdf');
  const { stdout } = await run(process.execPath, ['bin/verify-report.mjs', file], { cwd: process.cwd() });
  const cli = JSON.parse(stdout) as { verdict: { kind: string; matched: { recordId: string }; latest: { recordId: string } }; reanchored: { index: number; sourceBlock: number } };
  expect({ kind: cli.verdict.kind, matched: cli.verdict.matched.recordId, latest: cli.verdict.latest.recordId, index: cli.reanchored.index }).toEqual(onSite);
  expect(cli.reanchored.sourceBlock).toBe(f.sourceBlock);
});
