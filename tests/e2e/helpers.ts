import { randomInt } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { generate } from 'otplib';

export interface TestUser {
  email: string;
  password: string;
  /** The base32 TOTP secret of an account with two-step sign-in on. */
  totp?: string;
}

export const preparer: TestUser = { email: process.env.SEED_PREPARER_EMAIL ?? '', password: process.env.SEED_PREPARER_PASSWORD ?? '' };
/** Seeded with two-step sign-in on (SEED_APPROVER_TOTP_SECRET), as every approver must have it. */
export const approver: TestUser = { email: process.env.SEED_APPROVER_EMAIL ?? '', password: process.env.SEED_APPROVER_PASSWORD ?? '', totp: process.env.SEED_APPROVER_TOTP_SECRET };
/** Seeded with two-step sign-in on (SEED_ADMIN_TOTP_SECRET); asks for revocations. */
export const admin: TestUser = { email: process.env.SEED_ADMIN_EMAIL ?? '', password: process.env.SEED_ADMIN_PASSWORD ?? '', totp: process.env.SEED_ADMIN_TOTP_SECRET };

const PERIOD = 30;
const lastStep = new Map<string, number>();

/**
 * A code for a time step this process has not used for the secret yet: the
 * app accepts each step once. The next step is still within the app's
 * tolerance; beyond that, wait for the clock.
 */
export async function nextCode(secret: string): Promise<string> {
  for (;;) {
    const step = Math.floor(Date.now() / 1000 / PERIOD);
    const use = Math.max(step, (lastStep.get(secret) ?? 0) + 1);
    if (use <= step + 1) {
      lastStep.set(secret, use);
      return generate({ secret, epoch: use * PERIOD });
    }
    await new Promise((resolve) => setTimeout(resolve, ((step + 1) * PERIOD + 1) * 1000 - Date.now()));
  }
}

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

interface Addresses {
  current: string;
  byPerson: Map<string, string>;
}
const addresses = new WeakMap<BrowserContext, Addresses>();

/**
 * Gives requests to the app a client address, as a trusted proxy would set it
 * (the test server trusts X-Forwarded-For): sign-in is limited per address,
 * and parallel tests are different people, not one office signing in a dozen
 * times a minute. Within one test each person signs in from an address of
 * their own, as they would from their own machine; the browser keeps using
 * the address of whoever signed in last.
 */
export async function fromOwnAddress(page: Page, person = '') {
  const context = page.context();
  let state = addresses.get(context);
  if (!state) {
    const created: Addresses = { current: '', byPerson: new Map() };
    addresses.set(context, created);
    state = created;
    const app = new URL(test.info().project.use.baseURL ?? 'http://127.0.0.1:3100').origin;
    await context.route(
      (url) => url.origin === app,
      (route) => route.continue({ headers: { ...route.request().headers(), 'x-forwarded-for': created.current } }),
    );
  }
  let address = state.byPerson.get(person);
  if (!address) {
    address = `198.18.${randomInt(256)}.${randomInt(1, 255)}`;
    state.byPerson.set(person, address);
  }
  state.current = address;
}

export async function signIn(page: Page, user: TestUser) {
  await fromOwnAddress(page, user.email);
  await page.goto('/login');
  await page.getByRole('textbox', { name: 'Email' }).fill(user.email);
  await page.getByRole('textbox', { name: 'Password' }).fill(user.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  if (user.totp) {
    // Another test process may have just spent this period's code for the same account: then try the next one.
    for (let attempt = 0; attempt < 3; attempt++) {
      await page.getByTestId('login-code').fill(await nextCode(user.totp));
      await page.getByRole('button', { name: 'Sign in' }).click();
      if (await page.waitForURL(/\/reports$/, { timeout: 5_000 }).then(() => true, () => false)) return;
    }
  }
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

/**
 * Uploads a fixture on the engagement page and confirms its found opinion;
 * leaves the page on the version. A version after the first needs its reason.
 */
export async function uploadAndConfirm(page: Page, fixture: string, tag: string, reason?: 'CORRECTION' | 'SUBSEQUENT_EVENT' | 'OTHER') {
  await page.getByTestId('upload-file').setInputFiles({ name: 'report.pdf', mimeType: 'application/pdf', buffer: uniquePdf(fixture, tag) });
  if (reason) await page.getByTestId(`reason-${reason}`).click();
  await page.getByRole('button', { name: 'Upload' }).click();
  await expect(page).toHaveURL(/\/reports\/versions\//);
  await expect(page.getByTestId('extraction-found')).toBeVisible();
  await page.getByTestId('report-date').fill('2026-03-20');
  await page.getByTestId('confirm-opinion').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm opinion' }).click();
  await expect(page.getByTestId('confirmed-opinion')).toBeVisible();
}
