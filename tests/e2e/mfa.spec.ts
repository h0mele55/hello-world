import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import { expect, test, type Page } from '@playwright/test';
import { nextCode, runTag, fromOwnAddress } from './helpers';

/**
 * Roles and two-step sign-in (Phase 5, #52), through the UI. Each test makes
 * its own user in the seeded firm, so a run leaves the seeded accounts alone.
 */

async function createUser(role: 'ADMIN' | 'VIEWER') {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const { rows } = await client.query<{ id: string }>('SELECT id FROM "IssuerOrg" WHERE name = $1', [process.env.SEED_ORG_NAME]);
    const tag = runTag();
    const user = { email: `${role.toLowerCase()}-${tag}@e2e.example`, password: randomBytes(12).toString('hex') };
    await client.query('INSERT INTO "User" (id, "orgId", email, name, "passwordHash", role) VALUES ($1, $2, $3, $4, $5, $6::"Role")', [
      `e2e${tag}`,
      rows[0].id,
      user.email,
      role,
      await bcrypt.hash(user.password, 10),
      role,
    ]);
    return user;
  } finally {
    await client.end();
  }
}

async function enterPassword(page: Page, user: { email: string; password: string }) {
  await fromOwnAddress(page);
  await page.goto('/login');
  await page.getByRole('textbox', { name: 'Email' }).fill(user.email);
  await page.getByRole('textbox', { name: 'Password' }).fill(user.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

async function enterCode(page: Page, code: string) {
  await page.getByTestId('login-code').fill(code);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

async function signOut(page: Page) {
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login$/);
}

test('an admin sets up two-step sign-in before anything else, then signs in with a code or a recovery code', async ({ page }) => {
  const admin = await createUser('ADMIN');

  await test.step('signed in with a password only, the admin can do nothing but set it up', async () => {
    await enterPassword(page, admin);
    await expect(page).toHaveURL(/\/account\/mfa$/);
    await page.goto('/reports/settings');
    await expect(page).toHaveURL(/\/account\/mfa$/);
    const refused = await page.request.put('/api/org/chain-mode', { data: { mode: 'DRY_RUN' } });
    expect(refused.status()).toBe(403);
    expect(await refused.json()).toEqual({ error: 'MFA_REQUIRED' });
  });

  let secret = '';
  let recoveryCodes: string[] = [];
  await test.step('scanning the key and confirming a code turns it on and shows ten recovery codes once', async () => {
    await page.getByTestId('mfa-start').click();
    secret = (await page.getByTestId('mfa-secret').textContent()) ?? '';
    expect(secret).toMatch(/^[A-Z2-7]{16,}$/);
    await page.getByTestId('mfa-code').fill(await nextCode(secret));
    await page.getByTestId('mfa-confirm').click();
    await expect(page.getByTestId('recovery-code')).toHaveCount(10);
    recoveryCodes = await page.getByTestId('recovery-code').allTextContents();
    await page.getByTestId('mfa-sign-in-again').click();
    await expect(page).toHaveURL(/\/login$/);
  });

  await test.step('signing in now takes a code; a wrong one is refused', async () => {
    await enterPassword(page, admin);
    await enterCode(page, '000000');
    await expect(page.getByText('The code is wrong or was already used')).toBeVisible();
    await enterCode(page, await nextCode(secret));
    await expect(page).toHaveURL(/\/reports$/);
    await expect(page.getByTestId('nav-mfa')).toBeVisible();
    await page.goto('/reports/settings');
    await expect(page.getByTestId('current-mode')).toBeVisible();
    await signOut(page);
  });

  await test.step('a recovery code works once', async () => {
    await enterPassword(page, admin);
    await enterCode(page, recoveryCodes[0]);
    await expect(page).toHaveURL(/\/reports$/);
    await signOut(page);
    await enterPassword(page, admin);
    await enterCode(page, recoveryCodes[0]);
    await expect(page.getByText('The code is wrong or was already used')).toBeVisible();
  });
});

test('a viewer reads the reports and can change nothing', async ({ page }) => {
  const viewer = await createUser('VIEWER');
  await enterPassword(page, viewer);
  await expect(page).toHaveURL(/\/reports$/);
  await expect(page.getByTestId('new-engagement')).toHaveCount(0);
  await expect(page.getByTestId('nav-mfa')).toHaveCount(0);
  const refused = await page.request.post('/api/engagements', { data: {} });
  expect(refused.status()).toBe(403);
  expect(await refused.json()).toEqual({ error: 'FORBIDDEN' });
  await page.goto('/reports/settings');
  await expect(page.getByText('Only an approver or an admin can change the write mode.')).toBeVisible();
});
