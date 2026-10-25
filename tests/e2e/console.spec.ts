import AxeBuilder from '@axe-core/playwright';
import pg from 'pg';
import { expect, test, type Page } from '@playwright/test';
import { THEME_COOKIE } from '../../src/lib/preferences';
import { createEngagement, preparer, runTag, signIn, uploadAndConfirm } from './helpers';

/**
 * The issuer console (Phase 5, #53 #54): the client list, a client, an
 * engagement's version timeline and the dashboard, each with real rows, its
 * empty state, and WCAG 2.2 AA in both themes.
 */

const WCAG_22_AA = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function violations(page: Page) {
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG_22_AA).analyze();
  return violations.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`);
}

async function withDb<T>(run: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

async function chooseTheme(page: Page, theme: 'light' | 'dark') {
  await page.context().addCookies([{ name: THEME_COOKIE, value: theme, url: 'http://127.0.0.1:3100' }]);
}

test('a preparer finds a client, its engagement and the version timeline', async ({ page }) => {
  const tag = runTag();
  await signIn(page, preparer);
  await createEngagement(page, tag);
  await uploadAndConfirm(page, 'en-unmodified.pdf', tag);

  await page.getByTestId('nav-clients').click();
  await expect(page).toHaveURL(/\/clients$/);
  await expect(page.getByTestId('nav-clients')).toHaveAttribute('aria-current', 'page');
  await page.getByTestId('clients-table-search').fill(`E2E${tag}`);
  await expect(page.getByTestId('clients-table-row')).toHaveCount(1);
  const row = page.getByTestId('clients-table-row');
  await expect(row).toContainText('Example Manufacturing AD');
  await expect(row).toContainText('1');

  // A search that matches nothing says so, and clearing it brings the list back.
  await page.getByTestId('clients-table-search').fill(`nothing-${tag}`);
  await expect(page.getByTestId('clients-table-row')).toHaveCount(0);
  await page.getByTestId('clients-table-clear').click();
  await expect(page.getByTestId('clients-table-search')).toHaveValue('');
  await page.getByTestId('clients-table-search').fill(`E2E${tag}`);

  await row.getByTestId('client-link').click();
  await expect(page).toHaveURL(/\/clients\/[^/]+$/);
  await expect(page.getByTestId('client-summary')).toContainText(`E2E${tag}`);
  const engagement = page.getByTestId('engagements-table-row');
  await expect(engagement).toHaveCount(1);
  await expect(engagement).toContainText('Opinion confirmed');

  await engagement.getByTestId('engagement-link').click();
  await expect(page).toHaveURL(/\/reports\/[^/]+$/);
  const version = page.getByTestId('timeline-version');
  await expect(version).toHaveCount(1);
  await expect(version).toHaveAttribute('data-status', 'CONFIRMED');
  await expect(version.getByTestId('timeline-prepared')).toContainText(preparer.email);
  await expect(version.getByTestId('timeline-approved')).toHaveText('Not approved yet');
  await expect(version).toContainText('Not anchored yet');
});

test('the client list sorts and pages', async ({ page }) => {
  const tag = runTag();
  // Twenty-five clients of the seeded firm, so the list has a second page whatever else is in the database.
  await withDb(async (db) => {
    const { rows } = await db.query<{ id: string }>('SELECT id FROM "IssuerOrg" WHERE name = $1', [process.env.SEED_ORG_NAME]);
    for (let i = 0; i < 25; i++) {
      await db.query('INSERT INTO "Client" (id, "orgId", name, "registrationNumber", country) VALUES ($1, $2, $3, $4, $5)', [`pager${tag}${i}`, rows[0].id, `Pager ${tag} ${String(i).padStart(2, '0')}`, `PG${tag}${i}`, 'BG']);
    }
  });
  await signIn(page, preparer);
  await page.goto('/clients');
  await page.getByTestId('clients-table-search').fill(`Pager ${tag}`);
  await expect(page.getByTestId('clients-table-count')).toHaveText(/^25 of \d+ match$/);
  await expect(page.getByTestId('clients-table-row')).toHaveCount(20);
  await expect(page.getByTestId('clients-table-page')).toHaveText('Page 1 of 2');
  await expect(page.getByTestId('clients-table-row').first()).toContainText(`Pager ${tag} 00`);

  await page.getByTestId('clients-table-next').click();
  await expect(page.getByTestId('clients-table-row')).toHaveCount(5);
  await expect(page.getByTestId('clients-table-page')).toHaveText('Page 2 of 2');
  await expect(page.getByTestId('clients-table-next')).toBeDisabled();

  // Sorting by name, descending, starts from the other end.
  const nameHeader = page.locator('th', { has: page.getByTestId('sort-name') });
  await expect(nameHeader).toHaveAttribute('aria-sort', 'ascending');
  await page.getByTestId('sort-name').click();
  await expect(nameHeader).toHaveAttribute('aria-sort', 'descending');
  await expect(page.getByTestId('clients-table-row').first()).toContainText(`Pager ${tag} 24`);
});

test('the dashboard counts a lookup of the firm’s family and draws it, in both themes', async ({ page, browser }) => {
  const tag = runTag();
  await signIn(page, preparer);
  await createEngagement(page, tag);
  const familyId = await withDb(async (db) => {
    const { rows } = await db.query<{ familyId: string }>('SELECT e."familyId" FROM "Engagement" e JOIN "Client" c ON c.id = e."clientId" WHERE c."registrationNumber" = $1', [`E2E${tag}`]);
    return rows[0].familyId;
  });

  await page.goto('/dashboard');
  const before = Number(await page.getByTestId('tile-lookups').getAttribute('data-value'));

  // A visitor, signed out, opens the family's latest-version page.
  const visitor = await browser.newPage();
  await visitor.goto(`/r/${familyId}/latest`);
  await expect(visitor.getByTestId('latest-page')).toBeVisible();
  await visitor.close();

  await expect
    .poll(
      async () => {
        await page.reload();
        return Number(await page.getByTestId('tile-lookups').getAttribute('data-value'));
      },
      { timeout: 15_000 },
    )
    .toBeGreaterThan(before);
  const today = new Date().toISOString().slice(0, 10);
  await expect(page.getByTestId('lookups-chart-table').locator(`tr[data-period="${today}"] td[data-series="lookups"]`)).not.toHaveText('0');

  for (const theme of ['light', 'dark'] as const) {
    await chooseTheme(page, theme);
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    // The vendored chart draws a bar for today, in a colour the theme can tell from its background.
    const bar = page.getByTestId('lookups-chart').locator('path.visx-bar-rounded[fill="currentColor"]').last();
    await expect(bar).toBeVisible();
    const [barColour, background] = await bar.evaluate((el) => [getComputedStyle(el).color, getComputedStyle(document.body).backgroundColor]);
    expect(barColour).not.toBe(background);
    await expect(page.getByTestId('anchors-chart-table').locator('tbody tr')).toHaveCount(12);
    await expect(page.getByTestId('writes-by-status').locator('tbody tr')).toHaveCount(6);
    expect(await violations(page)).toEqual([]);
  }
});

test('the console pages pass WCAG 2.2 AA in both themes', async ({ page }) => {
  const tag = runTag();
  await signIn(page, preparer);
  await createEngagement(page, tag);
  const engagementUrl = page.url();
  await page.goto('/clients');
  await page.getByTestId('clients-table-search').fill(`E2E${tag}`);
  await page.getByTestId('client-link').click();
  await expect(page.getByTestId('engagements-table-row')).toHaveCount(1);
  const clientUrl = page.url();

  for (const theme of ['light', 'dark'] as const) {
    await chooseTheme(page, theme);
    for (const url of ['/clients', clientUrl, engagementUrl]) {
      await page.goto(url);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      expect(await violations(page), `${url} (${theme})`).toEqual([]);
    }
  }
});
