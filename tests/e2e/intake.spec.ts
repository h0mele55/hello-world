import { expect, test } from '@playwright/test';
import { BUNDLE_OPINIONS, twoReportsPdf } from '../helpers/minimal-pdf';
import { approver, createEngagement, preparer, runTag, signIn, uniquePdf } from './helpers';

/**
 * Phase 2 end to end: a preparer creates an engagement, uploads a report,
 * reads the extracted opinion beside the rendered PDF and confirms it; an
 * approver sees the result but cannot upload. Needs the app's database,
 * seeded with the two users whose credentials are in SEED_* (see CI).
 */

test.skip(!preparer.password && !process.env.CI, 'needs a seeded database (SEED_* variables)');

test('a preparer uploads a report and confirms its opinion; an approver sees it read-only', async ({ page }) => {
  const tag = runTag();

  await test.step('the preparer creates an engagement', async () => {
    await signIn(page, preparer);
    await createEngagement(page, tag);
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

test('a PDF holding two reports offers both, and the preparer’s choice is recorded (#77)', async ({ page }) => {
  const tag = runTag();
  await signIn(page, preparer);
  await createEngagement(page, tag);
  await page.getByTestId('upload-file').setInputFiles({ name: 'accounts.pdf', mimeType: 'application/pdf', buffer: twoReportsPdf(tag) });
  await page.getByRole('button', { name: 'Upload' }).click();
  await expect(page).toHaveURL(/\/reports\/versions\//);

  await expect(page.getByTestId('extraction-candidates')).toHaveAttribute('data-count', '2');
  await page.getByTestId('report-date').fill('2026-03-20');
  // Nothing is filled in, and nothing can be confirmed, until a report is chosen.
  await expect(page.getByTestId('opinion-text')).toHaveValue('');
  await expect(page.getByTestId('confirm-opinion')).toBeDisabled();
  await page.getByTestId('opinionCandidate-c1').click();
  await expect(page.getByTestId('opinion-text')).toHaveValue(BUNDLE_OPINIONS.pensionFund);
  await expect(page.getByTestId('opinionType-UNMODIFIED')).toBeChecked();
  await page.getByTestId('opinionCandidate-c0').click();
  await expect(page.getByTestId('opinion-text')).toHaveValue(BUNDLE_OPINIONS.council);
  await expect(page.getByTestId('opinionType-DISCLAIMER')).toBeChecked();

  await page.getByTestId('confirm-opinion').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm opinion' }).click();
  await expect(page.getByTestId('confirmed-text')).toHaveText(BUNDLE_OPINIONS.council);
  await expect(page.getByTestId('confirmed-candidate')).toHaveText('Taken from report 1 of the 2 in this PDF (pages 1–1).');
});
