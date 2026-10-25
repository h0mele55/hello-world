import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * Phase 2 end to end: a preparer creates an engagement, uploads a report,
 * reads the extracted opinion beside the rendered PDF and confirms it; an
 * approver sees the result but cannot upload. Needs the app's database,
 * seeded with the two users whose credentials are in SEED_* (see CI).
 */

const preparer = { email: process.env.SEED_PREPARER_EMAIL ?? '', password: process.env.SEED_PREPARER_PASSWORD ?? '' };
const approver = { email: process.env.SEED_APPROVER_EMAIL ?? '', password: process.env.SEED_APPROVER_PASSWORD ?? '' };

test.skip(!preparer.password && !process.env.CI, 'needs a seeded database (SEED_* variables)');

/** A fixture made unique for this run, so its file hash has never been uploaded before. */
function uniquePdf(name: string, tag: string): Buffer {
  const bytes = fs.readFileSync(path.join(process.cwd(), 'tests', 'fixtures', 'pdf', name));
  return Buffer.concat([bytes, Buffer.from(`%e2e ${tag}\n`)]);
}

async function signIn(page: Page, user: { email: string; password: string }) {
  await page.goto('/login');
  await page.getByRole('textbox', { name: 'Email' }).fill(user.email);
  await page.getByRole('textbox', { name: 'Password' }).fill(user.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/reports$/);
}

test('a preparer uploads a report and confirms its opinion; an approver sees it read-only', async ({ page }) => {
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  await test.step('the preparer creates an engagement', async () => {
    await signIn(page, preparer);
    await page.getByTestId('new-engagement').click();
    await page.getByRole('textbox', { name: 'Client name' }).fill('Example Manufacturing AD');
    await page.getByRole('textbox', { name: 'Registration number' }).fill(`E2E${tag.replace(/\D/g, '').slice(0, 12)}`);
    await page.getByRole('textbox', { name: 'Engagement reference' }).fill(`E2E-${tag}`);
    await page.locator('input[name=periodEnd]').fill('2025-12-31');
    await page.getByRole('button', { name: 'Create engagement' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Example Manufacturing AD' })).toBeVisible();
  });

  await test.step('a file that is not a PDF is refused with its reason', async () => {
    await page.getByTestId('upload-file').setInputFiles({ name: 'report.pdf', mimeType: 'application/pdf', buffer: Buffer.from('<html>not a pdf</html>') });
    await page.getByRole('button', { name: 'Upload' }).click();
    await expect(page.getByTestId('error-message')).toHaveAttribute('data-code', 'NOT_A_PDF');
  });

  await test.step('the report uploads and its opinion is found', async () => {
    await page.getByTestId('upload-file').setInputFiles({ name: 'report.pdf', mimeType: 'application/pdf', buffer: uniquePdf('en-qualified.pdf', tag) });
    await page.getByRole('button', { name: 'Upload' }).click();
    await expect(page).toHaveURL(/\/reports\/versions\//);
    await expect(page.getByTestId('extraction-found')).toContainText('Qualified Opinion');
    await expect(page.getByTestId('opinion-text')).toHaveValue(/except for the effects of the matter/);
    await expect(page.getByTestId('opinionType-QUALIFIED')).toHaveAttribute('data-state', 'checked');
    await expect(page.getByTestId('pdf-page')).toHaveText(/Page 1 of 2/);
  });

  const versionUrl = page.url();

  await test.step('the preparer confirms in the dialog, and the commitments appear', async () => {
    await expect(page.getByTestId('confirm-opinion')).toBeDisabled();
    await page.getByTestId('report-date').fill('2026-03-20');
    await page.getByTestId('confirm-opinion').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Confirm opinion' }).click();
    await expect(page.getByTestId('confirmed-opinion')).toBeVisible();
    await expect(page.getByTestId('confirmed-type')).toHaveText('Qualified');
    await expect(page.getByText(/^0x[0-9a-f]{64}$/)).toHaveCount(3);
  });

  await test.step('the approver sees the confirmed version and cannot upload', async () => {
    await page.context().clearCookies();
    await signIn(page, approver);
    await expect(page.getByTestId('new-engagement')).toHaveCount(0);
    await page.goto(versionUrl);
    await expect(page.getByTestId('confirmed-type')).toHaveText('Qualified');
    await expect(page.getByTestId('confirm-opinion-form')).toHaveCount(0);
  });
});

test('signed-out visitors are sent to sign in, and the APIs refuse them', async ({ page, request }) => {
  await page.goto('/reports');
  await expect(page).toHaveURL(/\/login$/);
  const response = await request.post('/api/engagements', { data: {}, headers: { origin: 'http://127.0.0.1:3100' } });
  expect(response.status()).toBe(401);
});
