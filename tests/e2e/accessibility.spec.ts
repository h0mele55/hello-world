import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { LOCALE_COOKIE, THEME_COOKIE } from '../../src/lib/preferences';
import { runTag, uniquePdf } from './helpers';

/**
 * WCAG 2.2 AA on the verifier, in both languages and both themes, before and
 * after a verdict: the page anyone may be sent to must be usable by everyone
 * (Phase 4 hardening, #50).
 */

test.skip(!process.env.ANCHOR_NETWORK && !process.env.CI, 'needs a local chain (ANCHOR_NETWORK=local; see CI)');

const WCAG_22_AA = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function violations(page: Page) {
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG_22_AA).analyze();
  return violations.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`);
}

for (const locale of ['en', 'bg'] as const) {
  for (const theme of ['light', 'dark'] as const) {
    test(`/verify passes WCAG 2.2 AA in ${locale}, ${theme} theme, before and after a verdict`, async ({ page, context }) => {
      await context.addCookies([
        { name: LOCALE_COOKIE, value: locale, url: 'http://127.0.0.1:3100' },
        { name: THEME_COOKIE, value: theme, url: 'http://127.0.0.1:3100' },
      ]);
      await page.goto('/verify');
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      expect(await violations(page)).toEqual([]);
      await page.getByTestId('verify-file').setInputFiles({ name: 'report.pdf', mimeType: 'application/pdf', buffer: uniquePdf('en-qualified.pdf', runTag()) });
      await expect(page.getByTestId('verdict')).toBeVisible({ timeout: 30_000 });
      expect(await violations(page)).toEqual([]);
    });
  }
}

test('the latest-version page passes WCAG 2.2 AA', async ({ page }) => {
  await page.goto(`/r/0x${'ab'.repeat(32)}/latest`);
  expect(await violations(page)).toEqual([]);
});

const HTML = path.join(process.cwd(), 'dist', 'verifier.html');

test('the single-file verifier passes WCAG 2.2 AA', async ({ page }) => {
  test.skip(!fs.existsSync(HTML) && !process.env.CI, 'run `npm run build:verifier` first');
  await page.goto(pathToFileURL(HTML).href);
  expect(await violations(page)).toEqual([]);
  await page.getByTestId('verify-file').setInputFiles({ name: 'report.pdf', mimeType: 'application/pdf', buffer: uniquePdf('en-qualified.pdf', runTag()) });
  await expect(page.getByTestId('verdict')).toBeVisible({ timeout: 30_000 });
  expect(await violations(page)).toEqual([]);
});
