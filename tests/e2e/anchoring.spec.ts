import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { admin, approver, createEngagement, preparer, runTag, signIn, uniquePdf, uploadAndConfirm } from './helpers';

/**
 * Phase 3 end to end, on a local Anvil chain: an approver widens the write
 * mode one rung at a time, approves a dry run that is only simulated, then a
 * live anchor that the worker sends and settles once its block is finalized;
 * the worker then stamps and anchors the distribution copy, which can be
 * downloaded once the version is complete. A signed report gets a
 * verification certificate instead. Then the Phase 5 exit gate (#60): a
 * recipient is listed, version 2 supersedes version 1, the recipient is
 * emailed a link to the latest record and nothing else, an admin asks for
 * version 1 to be revoked, a different approver approves, and the verifier
 * reports every copy of version 1 as revoked and version 2 as the latest.
 *
 * Needs, besides the seeded database: Anvil at LOCAL_RPC_URL started with
 * `--slots-in-an-epoch 1`, the registry deployed there (deployments/local.json),
 * ANCHOR_NETWORK=local and ISSUER_ADDRESS for the app, and ISSUER_PRIVATE_KEY
 * for the worker, which this test runs as a process of its own. The app's
 * server is started without the key (playwright.config.ts). The recipients'
 * email needs Mailpit: SMTP_URL and MAIL_FROM for the mailer, MAILPIT_URL to
 * read what it sent. See the CI job.
 */

test.skip(!process.env.ANCHOR_NETWORK && !process.env.CI, 'needs a local chain (ANCHOR_NETWORK=local; see CI)');

function runWorkerOnce() {
  execFileSync(path.join(process.cwd(), 'node_modules', '.bin', 'tsx'), ['scripts/worker.ts', '--once'], { env: process.env, stdio: 'pipe' });
}

/** The mailer, as its own process too: it holds no issuer key. */
function runMailerOnce() {
  const env = { ...process.env };
  delete env.ISSUER_PRIVATE_KEY;
  execFileSync(path.join(process.cwd(), 'node_modules', '.bin', 'tsx'), ['scripts/mailer.ts', '--once'], { env, stdio: 'pipe' });
}

interface MailpitMessage {
  ID: string;
  To: { Address: string }[];
  Subject: string;
  Text: string;
  HTML: string;
  Attachments: unknown[];
  Inline: unknown[];
}

/** Every message Mailpit holds for one address, read through its API. */
async function mailTo(address: string): Promise<MailpitMessage[]> {
  const base = process.env.MAILPIT_URL ?? 'http://127.0.0.1:8025';
  const found = (await (await fetch(`${base}/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}`)).json()) as { messages: { ID: string }[] };
  return Promise.all(found.messages.map(async (m) => (await (await fetch(`${base}/api/v1/message/${m.ID}`)).json()) as MailpitMessage));
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

/** The newest journal row for the original (the list is newest first, copies included). */
const originalWrite = (page: Page) => page.locator('[data-testid=chain-write][data-kind=ANCHOR]').first();

async function approve(page: Page, label: string) {
  await page.getByTestId('approve-anchor').filter({ hasText: label }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByTestId('anchor-queued')).toBeVisible();
}

test('a dry run is simulated; a live anchor is final, copied and downloadable; version 2 supersedes, recipients are told, and version 1 is revoked', async ({ page }) => {
  test.setTimeout(360_000);
  const tag = runTag();
  let versionUrl = '';
  let engagementUrl = '';
  let copy: Buffer = Buffer.alloc(0);

  await test.step('the preparer uploads a report and confirms its opinion', async () => {
    await signIn(page, preparer);
    await createEngagement(page, tag);
    await uploadAndConfirm(page, 'en-unmodified.pdf', tag);
    versionUrl = page.url();
    await expect(page.getByTestId('anchoring-panel')).toContainText('Waiting for an approver');
    await expect(page.getByTestId('commitments-hint')).toContainText('Nothing has been anchored yet.');
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
    await expect(originalWrite(page)).toHaveAttribute('data-status', 'SIMULATED');
    await expect(page.getByTestId('chain-write-reason').first()).toContainText('a live anchor would be accepted');
    await expect(page.getByTestId('approve-anchor')).toBeVisible();
  });

  await test.step('live: approved, sent, then final only once its block is finalized', async () => {
    await setMode(page, 'LIVE');
    await page.goto(versionUrl);
    await approve(page, 'Approve anchor');
    runWorkerOnce();
    await page.reload();
    await expect(originalWrite(page)).toHaveAttribute('data-status', 'BROADCAST');
    await expect(page.getByTestId('anchored')).toHaveCount(0);

    await mine(3);
    runWorkerOnce();
    await page.reload();
    await expect(originalWrite(page)).toHaveAttribute('data-status', 'FINAL');
    await expect(page.getByTestId('anchored')).toBeVisible();
    await expect(page.getByTestId('anchor-record-id')).toHaveText(/^0x[0-9a-f]{64}$/);
    await expect(page.getByTestId('copy-pending')).toBeVisible();
  });

  await test.step('the distribution copy is stamped and anchored; the version is complete', async () => {
    // The pass that settled the original also stamped and sent its copy.
    await expect(page.locator('[data-testid=chain-write][data-kind=ANCHOR_COPY]')).toHaveAttribute('data-status', 'BROADCAST');
    await mine(3);
    runWorkerOnce();
    await page.reload();
    await expect(page.getByTestId('complete')).toBeVisible();
    await expect(page.getByTestId('commitments-hint')).toHaveText('Only these values went on chain, in the record below.');
    await expect(page.getByTestId('copy-record-id')).toHaveText(/^0x[0-9a-f]{64}$/);
    await expect(page.getByText('Complete', { exact: true })).toBeVisible();
    const response = await page.request.get(await page.getByTestId('download-copy').getAttribute('href') ?? '');
    expect(response.status()).toBe(200);
    const pdf = await response.body();
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.toString('latin1')).toContain('https://github.com/h0mele55/hello-world/ns/audit-anchor/1.0/');
    copy = pdf;
  });

  await test.step('the engagement’s timeline shows where the version landed', async () => {
    const block = await page.getByTestId('anchor-block').textContent();
    const recordId = await page.getByTestId('anchor-record-id').textContent();
    await page.getByRole('link', { name: /Example Manufacturing AD/ }).click();
    await page.waitForURL(/\/reports\/(?!versions\/)[^/]+$/);
    engagementUrl = page.url();
    const version = page.getByTestId('timeline-version');
    await expect(version).toHaveCount(1);
    await expect(version).toHaveAttribute('data-status', 'COMPLETE');
    await expect(version.getByTestId('timeline-approved')).toContainText(approver.email);
    await expect(version.getByTestId('timeline-block')).toHaveText(block!);
    await expect(version.getByTestId('timeline-record')).toHaveText(recordId!);
    await expect(version.getByTestId('timeline-tx')).toHaveText(/^0x[0-9a-f]{64}$/);
    await expect(version.getByTestId('timeline-latest')).toBeVisible();
    await expect(version.getByTestId('timeline-copy')).toHaveAttribute('href', /\/api\/versions\/[^/]+\/copy$/);
  });

  await test.step('anyone verifies the copy and the original in a browser, signed out', async () => {
    await page.context().clearCookies();
    const issuerName = (JSON.parse(fs.readFileSync(path.join(process.cwd(), 'deployments', 'local.json'), 'utf8')) as { issuer: { orgName: string } }).issuer.orgName;
    const verify = async (buffer: Buffer) => {
      await page.getByTestId('verify-file').setInputFiles({ name: 'report.pdf', mimeType: 'application/pdf', buffer });
      await expect(page.getByTestId('verdict')).toBeVisible({ timeout: 30_000 });
    };
    await page.goto('/verify');
    await verify(copy);
    await expect(page.getByTestId('verdict')).toHaveAttribute('data-kind', 'AUTHENTIC_LATEST');
    await expect(page.getByTestId('record-matched')).toContainText('Distribution copy');
    await expect(page.getByTestId('record-matched-issuer')).toHaveText(issuerName);

    await page.getByTestId('verify-another').click();
    await expect(page.getByTestId('verdict')).toHaveCount(0);
    await verify(uniquePdf('en-unmodified.pdf', tag));
    await expect(page.getByTestId('verdict')).toHaveAttribute('data-kind', 'AUTHENTIC_LATEST');
    await expect(page.getByTestId('record-matched')).toContainText('Original');

    // Bytes appended after the end of the file: not the registered file, though its opinion reads the same.
    await page.getByTestId('verify-another').click();
    await expect(page.getByTestId('verdict')).toHaveCount(0);
    await verify(Buffer.concat([copy, Buffer.from('\n%appended\n')]));
    await expect(page.getByTestId('verdict')).toHaveAttribute('data-kind', 'ALTERED_OPINION_APPEARS_UNCHANGED');
    await expect(page.getByTestId('verdict-body')).toContainText('This is not the file the issuer anchored');

    await page.getByTestId('latest-link').click();
    await expect(page.getByTestId('latest-page')).toHaveAttribute('data-status', 'FOUND');
    await expect(page.getByTestId('latest-status')).toHaveText('Current');
    await expect(page.getByTestId('record-latest-version')).toHaveText('Version 1');
  });

  await test.step('a signed report is anchored as issued and gets a certificate', async () => {
    await page.context().clearCookies();
    await signIn(page, preparer);
    await createEngagement(page, `${tag}9`);
    await uploadAndConfirm(page, 'en-signed.pdf', `${tag}9`);
    const signedUrl = page.url();
    await page.context().clearCookies();
    await signIn(page, approver);
    await page.goto(signedUrl);
    await approve(page, 'Approve anchor');
    runWorkerOnce();
    await mine(3);
    runWorkerOnce();
    await page.reload();
    await expect(page.getByTestId('complete')).toBeVisible();
    await expect(page.locator('[data-testid=chain-write][data-kind=ANCHOR_COPY]')).toHaveCount(0);
    const response = await page.request.get(await page.getByTestId('download-certificate').getAttribute('href') ?? '');
    expect(response.status()).toBe(200);
    expect((await response.body()).subarray(0, 5).toString()).toBe('%PDF-');
  });

  const recipients = { en: `maria-${tag}@lender.example`, bg: `georgi-${tag}@regulator.example` };

  await test.step('the preparer lists who holds the report', async () => {
    await page.context().clearCookies();
    await signIn(page, preparer);
    await page.goto(engagementUrl);
    await expect(page.getByTestId('no-recipients')).toBeVisible();
    for (const [locale, name, email] of [
      ['en', 'Maria Petrova', recipients.en],
      ['bg', 'Георги Иванов', recipients.bg],
    ] as const) {
      await page.getByTestId('recipient-name').fill(name);
      await page.getByTestId('recipient-email').fill(email.toUpperCase());
      await page.getByTestId(`recipientLocale-${locale}`).click();
      await page.getByTestId('add-recipient').click();
      await expect(page.locator(`[data-testid=recipient][data-email="${email}"]`)).toBeVisible();
    }
    // Nothing is sent for version 1: it supersedes nothing.
    await expect(page.getByTestId('recipient-last')).toHaveCount(0);
  });

  await test.step('version 2 supersedes version 1: issued, approved by someone else, anchored and complete', async () => {
    await uploadAndConfirm(page, 'en-qualified.pdf', tag, 'CORRECTION');
    const v2Url = page.url();
    await page.context().clearCookies();
    await signIn(page, approver);
    await page.goto(v2Url);
    await approve(page, 'Approve anchor');
    runWorkerOnce();
    await mine(3);
    runWorkerOnce();
    await mine(3);
    runWorkerOnce();
    await page.reload();
    await expect(page.getByTestId('complete')).toBeVisible();
  });

  await test.step('each recipient is emailed a link to the latest record, in their language, and nothing else', async () => {
    // Locally without Mailpit, only this step is left out; in CI the mailer refuses to start without it.
    if (!process.env.SMTP_URL && !process.env.CI) return;
    runMailerOnce();
    const [english] = await mailTo(recipients.en);
    const [bulgarian] = await mailTo(recipients.bg);
    expect(english.Subject).toContain('a newer version of the audit report for Example Manufacturing AD');
    expect(bulgarian.Subject).toContain('нова версия на одиторския доклад');
    for (const message of [english, bulgarian]) {
      // Plain text, no attachment, nothing inline: never the PDF.
      expect(message.Attachments).toEqual([]);
      expect(message.Inline).toEqual([]);
      expect(message.HTML).toBe('');
      expect(message.Text).toContain(`E2E-${tag}`);
      expect(message.Text).toMatch(/\/r\/0x[0-9a-f]{64}\/latest/);
      expect(message.Text).toContain('/verify');
      // No opinion text, and none of the report's figures or wording.
      for (const text of ['In our opinion', 'except for', 'Qualified', 'IFRS', 'financial position', '31 December']) {
        expect(message.Text).not.toContain(text);
      }
    }
    // Sent once each: a second pass finds nothing to send.
    runMailerOnce();
    expect(await mailTo(recipients.en)).toHaveLength(1);

    // The link leads to version 2, read from the chain, signed out.
    const latest = new URL(english.Text.match(/https?:\/\/\S+\/r\/0x[0-9a-f]{64}\/latest/)![0]);
    await page.context().clearCookies();
    await page.goto(latest.pathname);
    await expect(page.getByTestId('latest-page')).toHaveAttribute('data-status', 'FOUND');
    await expect(page.getByTestId('record-latest-version')).toHaveText('Version 2');

    await signIn(page, preparer);
    await page.goto(engagementUrl);
    await expect(page.getByTestId('recipient-last')).toHaveCount(2);
    for (const badge of await page.getByTestId('recipient-last').all()) await expect(badge).toContainText('Version 2: sent');
  });

  await test.step('an admin asks for the first version to be revoked, and an approver approves', async () => {
    test.skip(!admin.email, 'needs SEED_ADMIN_* (see CI)');
    await page.context().clearCookies();
    await signIn(page, admin);
    await page.goto(versionUrl);
    const panel = page.getByTestId('revocation-panel');
    await expect(panel).toHaveAttribute('data-status', 'NONE');
    await page.getByTestId('revocationReason-ISSUED_IN_ERROR').click();
    await page.getByTestId('revocation-note').fill('Issued against the wrong period.');
    await page.getByTestId('revocation-confirmation').fill('E2E-wrong');
    await expect(page.getByTestId('request-revocation')).toBeDisabled();
    await page.getByTestId('revocation-confirmation').fill(`E2E-${tag}`);
    await page.getByTestId('request-revocation').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Ask for revocation' }).click();
    await expect(panel).toHaveAttribute('data-status', 'REQUESTED');
    // Whoever asked cannot approve (rule 6), but may take the request back.
    await expect(page.getByTestId('approve-revocation')).toHaveCount(0);
    await expect(page.getByTestId('withdraw-revocation')).toBeVisible();

    await page.context().clearCookies();
    await signIn(page, approver);
    await page.goto(versionUrl);
    await expect(page.getByTestId('revocation-note-shown')).toHaveText('Issued against the wrong period.');
    await page.getByTestId('approve-revocation').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Approve revocation' }).click();
    await expect(panel).toHaveAttribute('data-status', 'APPROVED');

    runWorkerOnce();
    await page.reload();
    await expect(page.locator('[data-testid=chain-write][data-kind=REVOKE]')).toHaveAttribute('data-status', 'BROADCAST');
    // Sent, not final: not revoked yet (rule 2).
    await expect(panel).toHaveAttribute('data-status', 'APPROVED');
    await mine(3);
    runWorkerOnce();
    await page.reload();
    await expect(panel).toHaveAttribute('data-status', 'REVOKED');
    await expect(page.getByTestId('revocation-final')).toContainText('Issued in error (code 2)');
  });

  await test.step('the verifier reports version 1’s copy and original as revoked, and version 2 as the latest', async () => {
    test.skip(!admin.email, 'needs SEED_ADMIN_* (see CI)');
    await page.context().clearCookies();
    await page.goto('/verify');
    for (const file of [copy, uniquePdf('en-unmodified.pdf', tag)]) {
      await page.getByTestId('verify-file').setInputFiles({ name: 'report.pdf', mimeType: 'application/pdf', buffer: file });
      await expect(page.getByTestId('verdict')).toHaveAttribute('data-kind', 'REVOKED', { timeout: 30_000 });
      await page.getByTestId('verify-another').click();
      await expect(page.getByTestId('verdict')).toHaveCount(0);
    }
    // Version 2 stands: revoking version 1 says nothing about it.
    await page.getByTestId('verify-file').setInputFiles({ name: 'report.pdf', mimeType: 'application/pdf', buffer: uniquePdf('en-qualified.pdf', tag) });
    await expect(page.getByTestId('verdict')).toHaveAttribute('data-kind', 'AUTHENTIC_LATEST', { timeout: 30_000 });
  });
});
