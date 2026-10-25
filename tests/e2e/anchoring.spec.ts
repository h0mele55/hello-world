import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { approver, createEngagement, preparer, runTag, signIn, uploadAndConfirm } from './helpers';

/**
 * Phase 3a end to end, on a local Anvil chain: an approver widens the write
 * mode one rung at a time, approves a dry run that is only simulated, then a
 * live anchor that the worker sends and settles once its block is finalized.
 *
 * Needs, besides the seeded database: Anvil at LOCAL_RPC_URL started with
 * `--slots-in-an-epoch 1`, the registry deployed there (deployments/local.json),
 * ANCHOR_NETWORK=local and ISSUER_ADDRESS for the app, and ISSUER_PRIVATE_KEY
 * for the worker, which this test runs as a process of its own. The app's
 * server is started without the key (playwright.config.ts). See the CI job.
 */

test.skip(!process.env.ANCHOR_NETWORK && !process.env.CI, 'needs a local chain (ANCHOR_NETWORK=local; see CI)');

function runWorkerOnce() {
  execFileSync(path.join(process.cwd(), 'node_modules', '.bin', 'tsx'), ['scripts/worker.ts', '--once'], { env: process.env, stdio: 'pipe' });
}

async function mine(blocks: number) {
  const response = await fetch(process.env.LOCAL_RPC_URL ?? 'http://127.0.0.1:8545', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'anvil_mine', params: [`0x${blocks.toString(16)}`] }),
  });
  expect(response.ok).toBe(true);
}

const LADDER = ['DISABLED', 'DRY_RUN', 'LIVE'] as const;

/** Moves the firm's write mode to `mode` through the settings page: up one rung at a time, down at once. */
async function setMode(page: Page, mode: (typeof LADDER)[number]) {
  await page.goto('/reports/settings');
  for (;;) {
    const current = (await page.getByTestId('current-mode').getAttribute('data-mode')) as (typeof LADDER)[number];
    if (current === mode) return;
    const next = LADDER.indexOf(mode) < LADDER.indexOf(current) ? mode : LADDER[LADDER.indexOf(current) + 1];
    await page.getByTestId(`chainMode-${next}`).click();
    await page.getByTestId('change-mode').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Change mode' }).click();
    await expect(page.getByTestId('current-mode')).toHaveAttribute('data-mode', next);
  }
}

async function approve(page: Page, label: string) {
  await page.getByTestId('approve-anchor').filter({ hasText: label }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByTestId('anchor-queued')).toBeVisible();
}

test('a dry run is only simulated; a live anchor is sent and becomes final with its block', async ({ page }) => {
  test.setTimeout(180_000);
  const tag = runTag();
  let versionUrl = '';

  await test.step('the preparer uploads a report and confirms its opinion', async () => {
    await signIn(page, preparer);
    await createEngagement(page, tag);
    await uploadAndConfirm(page, 'en-unmodified.pdf', tag);
    versionUrl = page.url();
    await expect(page.getByTestId('anchoring-panel')).toContainText('Waiting for an approver');
    await expect(page.getByTestId('approve-anchor')).toHaveCount(0);
  });

  await test.step('the approver widens the write mode to a dry run', async () => {
    await page.context().clearCookies();
    await signIn(page, approver);
    await setMode(page, 'DISABLED');
    await page.goto(versionUrl);
    await expect(page.getByTestId('anchoring-disabled')).toBeVisible();
    await setMode(page, 'DRY_RUN');
  });

  await test.step('a dry-run approval is simulated, and the version waits for approval again', async () => {
    await page.goto(versionUrl);
    await approve(page, 'Approve dry run');
    runWorkerOnce();
    await page.reload();
    await expect(page.getByTestId('chain-write').first()).toHaveAttribute('data-status', 'SIMULATED');
    await expect(page.getByTestId('chain-write-reason').first()).toContainText('a live anchor would be accepted');
    await expect(page.getByTestId('approve-anchor')).toBeVisible();
  });

  await test.step('live: approved, sent, then final only once its block is finalized', async () => {
    await setMode(page, 'LIVE');
    await page.goto(versionUrl);
    await approve(page, 'Approve anchor');
    runWorkerOnce();
    await page.reload();
    await expect(page.getByTestId('chain-write').first()).toHaveAttribute('data-status', 'BROADCAST');
    await expect(page.getByTestId('anchored')).toHaveCount(0);

    await mine(3);
    runWorkerOnce();
    await page.reload();
    await expect(page.getByTestId('chain-write').first()).toHaveAttribute('data-status', 'FINAL');
    await expect(page.getByTestId('anchored')).toBeVisible();
    await expect(page.getByTestId('anchor-record-id')).toHaveText(/^0x[0-9a-f]{64}$/);
    await expect(page.getByText('Anchored', { exact: true })).toBeVisible();
  });
});
