import fs from 'node:fs';
import path from 'node:path';
import { expect, type Page } from '@playwright/test';

export const preparer = { email: process.env.SEED_PREPARER_EMAIL ?? '', password: process.env.SEED_PREPARER_PASSWORD ?? '' };
export const approver = { email: process.env.SEED_APPROVER_EMAIL ?? '', password: process.env.SEED_APPROVER_PASSWORD ?? '' };

/**
 * Digits unique to one test run, so engagements and file hashes collide
 * neither with earlier runs nor with tests running in parallel.
 */
export const runTag = () => `${Date.now()}${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;

/** A fixture made unique for this run, so its file hash has never been uploaded before. */
export function uniquePdf(name: string, tag: string): Buffer {
  const bytes = fs.readFileSync(path.join(process.cwd(), 'tests', 'fixtures', 'pdf', name));
  return Buffer.concat([bytes, Buffer.from(`%e2e ${tag}\n`)]);
}

export async function signIn(page: Page, user: { email: string; password: string }) {
  await page.goto('/login');
  await page.getByRole('textbox', { name: 'Email' }).fill(user.email);
  await page.getByRole('textbox', { name: 'Password' }).fill(user.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/reports$/);
}

export async function createEngagement(page: Page, tag: string) {
  await page.getByTestId('new-engagement').click();
  await page.getByRole('textbox', { name: 'Client name' }).fill('Example Manufacturing AD');
  await page.getByRole('textbox', { name: 'Registration number' }).fill(`E2E${tag}`);
  await page.getByRole('textbox', { name: 'Engagement reference' }).fill(`E2E-${tag}`);
  await page.locator('input[name=periodEnd]').fill('2025-12-31');
  await page.getByRole('button', { name: 'Create engagement' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Example Manufacturing AD' })).toBeVisible();
}

/** Uploads a fixture on the engagement page and confirms its found opinion; leaves the page on the version. */
export async function uploadAndConfirm(page: Page, fixture: string, tag: string) {
  await page.getByTestId('upload-file').setInputFiles({ name: 'report.pdf', mimeType: 'application/pdf', buffer: uniquePdf(fixture, tag) });
  await page.getByRole('button', { name: 'Upload' }).click();
  await expect(page).toHaveURL(/\/reports\/versions\//);
  await expect(page.getByTestId('extraction-found')).toBeVisible();
  await page.getByTestId('report-date').fill('2026-03-20');
  await page.getByTestId('confirm-opinion').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm opinion' }).click();
  await expect(page.getByTestId('confirmed-opinion')).toBeVisible();
}
