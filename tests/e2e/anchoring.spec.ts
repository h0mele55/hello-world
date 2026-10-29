import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { expect, test, type Browser, type Page } from '@playwright/test';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { hexToBytes } from 'viem';
import { serializeProof } from '../../src/lib/ots/format';
import { startFakeSealProvider, type FakeSealProvider } from '../helpers/fake-seal-provider';
import { startFakeStatusResponder, type FakeStatusResponder } from '../helpers/fake-status-responder';
import { createTestPki, pemOf } from '../helpers/test-pki';
import { admin, approver, createEngagement, preparer, runTag, signIn, uniquePdf, uploadAndConfirm, watchCsp, type TestUser } from './helpers';

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
 * read what it sent. See the CI job. The firm seals its copies (#70) through a
 * stand-in trust service provider on this machine, which the worker reaches
 * through the same settings as a real one's (scripts/seal-env.ts), at the
 * default level, B-LT (#119): the stand-in's certificates name a status
 * responder on this machine too, which the worker asks for their status.
 */

test.skip(!process.env.ANCHOR_NETWORK && !process.env.CI, 'needs a local chain (ANCHOR_NETWORK=local; see CI)');

let sealProvider: FakeSealProvider | undefined;
let statusResponder: FakeStatusResponder | undefined;
let sealEnv: Record<string, string> = {};
test.beforeAll(async () => {
  statusResponder = await startFakeStatusResponder();
  const pki = await createTestPki({ statusUrls: { ocsp: statusResponder.ocspUrl, crl: statusResponder.crlUrl }, intermediate: true });
  statusResponder.serve(pki);
  sealProvider = await startFakeSealProvider(pki);
  // The same file the app's server reads (playwright.config.ts), so /verify checks the seal against these roots (#120).
  const roots = process.env.E2E_SEAL_ROOTS!;
  fs.writeFileSync(roots, pemOf(pki.rootDer));
  sealEnv = {
    SEAL_PROVIDER: 'csc',
    CSC_URL: sealProvider.cscUrl,
    CSC_TOKEN_URL: sealProvider.tokenUrl,
    CSC_CLIENT_ID: sealProvider.clientId,
    CSC_CLIENT_SECRET: sealProvider.clientSecret,
    CSC_CREDENTIAL_ID: sealProvider.credentialId,
    TSA_URL: sealProvider.tsaUrl,
    SEAL_TRUST_ANCHORS: roots,
  };
});
test.afterAll(async () => {
  await sealProvider?.close();
  await statusResponder?.close();
});

/** One pass of the worker, as its own process; run without blocking, as the seal provider answers it from this one. */
function runWorkerOnce() {
  return new Promise<void>((resolve, reject) => {
    execFile(path.join(process.cwd(), 'node_modules', '.bin', 'tsx'), ['scripts/worker.ts', '--once'], { env: { ...process.env, ...sealEnv } }, (error, _stdout, stderr) =>
      error ? reject(new Error(`the worker failed: ${stderr}`)) : resolve(),
    );
  });
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

async function anvil(method: string, params: unknown[]) {
  const response = await fetch(process.env.LOCAL_RPC_URL ?? 'http://127.0.0.1:8545', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  expect(response.ok).toBe(true);
}

const mine = (blocks: number) => anvil('anvil_mine', [`0x${blocks.toString(16)}`]);
/** The registry is deployed with a one-hour revocation delay (REVOCATION_DELAY_HOURS=1, see CI): move the chain's clock past it. */
const passRevocationDelay = () => anvil('evm_increaseTime', [3600]);

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

/** What every person's page reported against the Content Security Policy (#84). */
const cspSeen: string[][] = [];
const cspViolations = () => cspSeen.flat();

/**
 * A browser of their own for each person, signed in once, as they would be:
 * the approver and the admin sign in with a code, and a code's time step is
 * accepted once, so signing in again and again would race the other tests.
 */
async function personPage(browser: Browser, user?: TestUser): Promise<Page> {
  const context = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  const page = await context.newPage();
  cspSeen.push(watchCsp(page));
  if (user) await signIn(page, user);
  return page;
}

test('a dry run is simulated; a live anchor is final, copied and downloadable; version 2 supersedes, recipients are told, and version 1 is revoked', async ({ page, browser }) => {
  test.setTimeout(360_000);
  const tag = runTag();
  let versionUrl = '';
  let engagementUrl = '';
  let copy: Buffer = Buffer.alloc(0);
  // The preparer works in the test's own page; the others in their own browsers.
  const prepared = page;
  cspSeen.push(watchCsp(prepared));
  let approving: Page;
  const visitor = await personPage(browser);

  await test.step('the preparer uploads a report and confirms its opinion', async () => {
    await signIn(prepared, preparer);
    await createEngagement(prepared, tag);
    await uploadAndConfirm(prepared, 'en-unmodified.pdf', tag);
    versionUrl = prepared.url();
    await expect(prepared.getByTestId('anchoring-panel')).toContainText('Waiting for an approver');
    await expect(prepared.getByTestId('commitments-hint')).toContainText('Nothing has been anchored yet.');
    await expect(prepared.getByTestId('approve-anchor')).toHaveCount(0);
  });

  await test.step('the approver widens the write mode to a dry run', async () => {
    approving = await personPage(browser, approver);
    await setMode(approving, 'DISABLED');
    await approving.goto(versionUrl);
    await expect(approving.getByTestId('anchoring-disabled')).toBeVisible();
    await setMode(approving, 'DRY_RUN');
  });

  await test.step('a dry-run approval is simulated, and the version waits for approval again', async () => {
    await approving.goto(versionUrl);
    await approve(approving, 'Approve dry run');
    await runWorkerOnce();
    await approving.reload();
    await expect(originalWrite(approving)).toHaveAttribute('data-status', 'SIMULATED');
    await expect(approving.getByTestId('chain-write-reason').first()).toContainText('a live anchor would be accepted');
    await expect(approving.getByTestId('approve-anchor')).toBeVisible();
  });

  await test.step('live: approved, sent, then final only once its block is finalized', async () => {
    await setMode(approving, 'LIVE');
    await approving.goto(versionUrl);
    await approve(approving, 'Approve anchor');
    await runWorkerOnce();
    await approving.reload();
    await expect(originalWrite(approving)).toHaveAttribute('data-status', 'BROADCAST');
    await expect(approving.getByTestId('anchored')).toHaveCount(0);

    await mine(3);
    await runWorkerOnce();
    await approving.reload();
    await expect(originalWrite(approving)).toHaveAttribute('data-status', 'FINAL');
    await expect(approving.getByTestId('anchored')).toBeVisible();
    await expect(approving.getByTestId('anchor-record-id')).toHaveText(/^0x[0-9a-f]{64}$/);
    await expect(approving.getByTestId('copy-pending')).toBeVisible();
    // Uploading, confirming beside the PDF viewer and approving ran under the app's CSP (#84).
    expect(cspViolations()).toEqual([]);
  });

  await test.step('the distribution copy is stamped and anchored; the version is complete', async () => {
    // The pass that settled the original also stamped and sent its copy.
    await expect(approving.locator('[data-testid=chain-write][data-kind=ANCHOR_COPY]')).toHaveAttribute('data-status', 'BROADCAST');
    await mine(3);
    await runWorkerOnce();
    await approving.reload();
    await expect(approving.getByTestId('complete')).toBeVisible();
    await expect(approving.getByTestId('commitments-hint')).toHaveText('Only these values went on chain, in the record below.');
    await expect(approving.getByTestId('copy-record-id')).toHaveText(/^0x[0-9a-f]{64}$/);
    await expect(approving.getByText('Complete', { exact: true })).toBeVisible();
    const response = await approving.request.get(await approving.getByTestId('download-copy').getAttribute('href') ?? '');
    expect(response.status()).toBe(200);
    const pdf = await response.body();
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.toString('latin1')).toContain('https://github.com/h0mele55/hello-world/ns/audit-anchor/1.0/');
    // Sealed by the firm (#70): one PAdES signature over the whole file, and the console says so.
    expect(pdf.toString('latin1')).toContain('/SubFilter /ETSI.CAdES.detached');
    await expect(approving.getByTestId('copy-sealed')).toContainText('electronic seal');
    copy = pdf;
    // The Bitcoin timestamp's card (#66): the OpenTimestamps job does not run here, so nothing is submitted yet.
    await expect(approving.getByTestId('ots-panel')).toHaveAttribute('data-status', 'NONE');
    await expect(approving.getByTestId('download-ots')).toHaveCount(0);
  });

  await test.step('the engagement’s timeline shows where the version landed', async () => {
    const block = await approving.getByTestId('anchor-block').textContent();
    const recordId = await approving.getByTestId('anchor-record-id').textContent();
    await approving.getByRole('link', { name: /Example Manufacturing AD/ }).click();
    await approving.waitForURL(/\/reports\/(?!versions\/)[^/]+$/);
    engagementUrl = approving.url();
    const version = approving.getByTestId('timeline-version');
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
    const issuerName = (JSON.parse(fs.readFileSync(path.join(process.cwd(), 'deployments', 'local.json'), 'utf8')) as { issuer: { orgName: string } }).issuer.orgName;
    const verify = async (buffer: Buffer) => {
      await visitor.getByTestId('verify-file').setInputFiles({ name: 'report.pdf', mimeType: 'application/pdf', buffer });
      await expect(visitor.getByTestId('verdict')).toBeVisible({ timeout: 30_000 });
    };
    await visitor.goto('/verify');
    await verify(copy);
    await expect(visitor.getByTestId('verdict')).toHaveAttribute('data-kind', 'AUTHENTIC_LATEST');
    await expect(visitor.getByTestId('record-matched')).toContainText('Distribution copy');
    await expect(visitor.getByTestId('record-matched-issuer')).toHaveText(issuerName);
    // The Bitcoin timestamp (#66), asked of the issuer by the manifest hash: none yet, as the OpenTimestamps job does not run here.
    await expect(visitor.getByTestId('bitcoin-timestamp')).toHaveAttribute('data-status', 'NONE');
    // The copy's electronic seal (#120), checked in the browser against the roots the firm publishes, beside the verdict.
    await expect(visitor.getByTestId('seal')).toHaveAttribute('data-status', 'SEALED', { timeout: 30_000 });
    await expect(visitor.getByTestId('seal-body')).toContainText('Example Audit OOD (test seal)');
    // Long-term (#119): the copy carries its certificates' status, and /verify checked it too.
    await expect(visitor.getByTestId('seal-long-term')).toBeVisible();

    // Had the issuer submitted it, the page would say it waits for Bitcoin: a pending proof of the very manifest it asked for.
    const asked: string[] = [];
    await visitor.route('**/ots/*', (route) => {
      const manifestHash = new URL(route.request().url()).pathname.split('/').pop() as `0x${string}`;
      asked.push(manifestHash);
      const pending = serializeProof({ digest: hexToBytes(manifestHash), timestamp: { attestations: [{ kind: 'pending', uri: 'https://alice.btc.calendar.opentimestamps.org' }], ops: [] } });
      return route.fulfill({ body: Buffer.from(pending), headers: { 'content-type': 'application/octet-stream' } });
    });
    await visitor.getByTestId('verify-another').click();
    await expect(visitor.getByTestId('verdict')).toHaveCount(0);
    await verify(uniquePdf('en-unmodified.pdf', tag));
    await expect(visitor.getByTestId('verdict')).toHaveAttribute('data-kind', 'AUTHENTIC_LATEST');
    await expect(visitor.getByTestId('record-matched')).toContainText('Original');
    await expect(visitor.getByTestId('bitcoin-timestamp')).toHaveAttribute('data-status', 'PENDING');
    // Only a copy is sealed; an original has no seal to report.
    await expect(visitor.getByTestId('seal')).toHaveCount(0);
    // The original and its copy share one manifest; only its hash was asked for, never the file's.
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/^0x[0-9a-f]{64}$/);
    await visitor.unrouteAll({ behavior: 'wait' });

    // Bytes appended after the end of the file: not the registered file, though its opinion reads the same.
    await visitor.getByTestId('verify-another').click();
    await expect(visitor.getByTestId('verdict')).toHaveCount(0);
    await verify(Buffer.concat([copy, Buffer.from('\n%appended\n')]));
    await expect(visitor.getByTestId('verdict')).toHaveAttribute('data-kind', 'ALTERED_OPINION_APPEARS_UNCHANGED');
    await expect(visitor.getByTestId('verdict-body')).toContainText('This is not the file the issuer anchored');
    // A file that is not the registered one gets no timestamp: the manifest's time says nothing about it. Nor a seal.
    await expect(visitor.getByTestId('bitcoin-timestamp')).toHaveCount(0);
    await expect(visitor.getByTestId('seal')).toHaveCount(0);

    await visitor.getByTestId('latest-link').click();
    await expect(visitor.getByTestId('latest-page')).toHaveAttribute('data-status', 'FOUND');
    await expect(visitor.getByTestId('latest-status')).toHaveText('Current');
    await expect(visitor.getByTestId('record-latest-version')).toHaveText('Version 1');
  });

  await test.step('a signed report is anchored as issued and gets a certificate', async () => {
    await prepared.goto('/reports');
    await createEngagement(prepared, `${tag}9`);
    await uploadAndConfirm(prepared, 'en-signed.pdf', `${tag}9`);
    await approving.goto(prepared.url());
    await approve(approving, 'Approve anchor');
    await runWorkerOnce();
    await mine(3);
    await runWorkerOnce();
    await approving.reload();
    await expect(approving.getByTestId('complete')).toBeVisible();
    await expect(approving.locator('[data-testid=chain-write][data-kind=ANCHOR_COPY]')).toHaveCount(0);
    const response = await approving.request.get(await approving.getByTestId('download-certificate').getAttribute('href') ?? '');
    expect(response.status()).toBe(200);
    expect((await response.body()).subarray(0, 5).toString()).toBe('%PDF-');
    // The worker names the published single-file verifier on it (#85).
    const task = pdfjs.getDocument({ data: new Uint8Array(await response.body()), verbosity: 0 });
    const content = await (await (await task.promise).getPage(1)).getTextContent();
    await task.destroy();
    expect(content.items.map((item) => ('str' in item ? item.str : '')).join(' ')).toContain(process.env.STANDALONE_VERIFIER_URL!);
  });

  const recipients = { en: `maria-${tag}@lender.example`, bg: `georgi-${tag}@regulator.example` };

  await test.step('the preparer lists who holds the report', async () => {
    await prepared.goto(engagementUrl);
    await expect(prepared.getByTestId('no-recipients')).toBeVisible();
    for (const [locale, name, email] of [
      ['en', 'Maria Petrova', recipients.en],
      ['bg', 'Георги Иванов', recipients.bg],
    ] as const) {
      await prepared.getByTestId('recipient-name').fill(name);
      await prepared.getByTestId('recipient-email').fill(email.toUpperCase());
      await prepared.getByTestId(`recipientLocale-${locale}`).click();
      await prepared.getByTestId('add-recipient').click();
      await expect(prepared.locator(`[data-testid=recipient][data-email="${email}"]`)).toBeVisible();
    }
    // Nothing is sent for version 1: it supersedes nothing.
    await expect(prepared.getByTestId('recipient-last')).toHaveCount(0);
  });

  await test.step('version 2 supersedes version 1: issued, approved by someone else, anchored and complete', async () => {
    await uploadAndConfirm(prepared, 'en-qualified.pdf', tag, 'CORRECTION');
    await approving.goto(prepared.url());
    await approve(approving, 'Approve anchor');
    await runWorkerOnce();
    await mine(3);
    await runWorkerOnce();
    await mine(3);
    await runWorkerOnce();
    await approving.reload();
    await expect(approving.getByTestId('complete')).toBeVisible();
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
    await visitor.goto(latest.pathname);
    await expect(visitor.getByTestId('latest-page')).toHaveAttribute('data-status', 'FOUND');
    await expect(visitor.getByTestId('record-latest-version')).toHaveText('Version 2');

    await prepared.goto(engagementUrl);
    await expect(prepared.getByTestId('recipient-last')).toHaveCount(2);
    for (const badge of await prepared.getByTestId('recipient-last').all()) await expect(badge).toContainText('Version 2: sent');
  });

  await test.step('an admin asks for the first version to be revoked, and an approver approves', async () => {
    test.skip(!admin.email, 'needs SEED_ADMIN_* (see CI)');
    const asking = await personPage(browser, admin);
    await asking.goto(versionUrl);
    const asked = asking.getByTestId('revocation-panel');
    await expect(asked).toHaveAttribute('data-status', 'NONE');
    await asking.getByTestId('revocationReason-ISSUED_IN_ERROR').click();
    await asking.getByTestId('revocation-note').fill('Issued against the wrong period.');
    await asking.getByTestId('revocation-confirmation').fill('E2E-wrong');
    await expect(asking.getByTestId('request-revocation')).toBeDisabled();
    await asking.getByTestId('revocation-confirmation').fill(`E2E-${tag}`);
    await asking.getByTestId('request-revocation').click();
    await asking.getByRole('dialog').getByRole('button', { name: 'Ask for revocation' }).click();
    await expect(asked).toHaveAttribute('data-status', 'REQUESTED');
    // Whoever asked cannot approve (rule 6), but may take the request back.
    await expect(asking.getByTestId('approve-revocation')).toHaveCount(0);
    await expect(asking.getByTestId('withdraw-revocation')).toBeVisible();

    await approving.goto(versionUrl);
    const panel = approving.getByTestId('revocation-panel');
    await expect(approving.getByTestId('revocation-note-shown')).toHaveText('Issued against the wrong period.');
    await approving.getByTestId('approve-revocation').click();
    await approving.getByRole('dialog').getByRole('button', { name: 'Approve revocation' }).click();
    await expect(panel).toHaveAttribute('data-status', 'APPROVED');

    await runWorkerOnce();
    await approving.reload();
    await expect(approving.locator('[data-testid=chain-write][data-kind=REVOKE]')).toHaveAttribute('data-status', 'BROADCAST');
    // Sent, not final: not revoked yet (rule 2).
    await expect(panel).toHaveAttribute('data-status', 'APPROVED');
    await mine(3);
    await runWorkerOnce();
    await approving.reload();
    // Final, and waiting out the registry's delay (#95): the owner may still cancel it.
    await expect(panel).toHaveAttribute('data-status', 'SCHEDULED');
    await expect(approving.getByTestId('revocation-scheduled')).toBeVisible();
  });

  await test.step('while the revocation waits out the delay, the verifier says version 1 is being withdrawn, never authentic', async () => {
    test.skip(!admin.email, 'needs SEED_ADMIN_* (see CI)');
    await visitor.goto('/verify');
    for (const file of [copy, uniquePdf('en-unmodified.pdf', tag)]) {
      await visitor.getByTestId('verify-file').setInputFiles({ name: 'report.pdf', mimeType: 'application/pdf', buffer: file });
      await expect(visitor.getByTestId('verdict')).toHaveAttribute('data-kind', 'REVOCATION_PENDING', { timeout: 30_000 });
      await visitor.getByTestId('verify-another').click();
      await expect(visitor.getByTestId('verdict')).toHaveCount(0);
    }
  });

  await test.step('once the delay has passed at a final block, the version is revoked', async () => {
    test.skip(!admin.email, 'needs SEED_ADMIN_* (see CI)');
    await passRevocationDelay();
    await mine(3);
    await runWorkerOnce();
    await approving.goto(versionUrl);
    const panel = approving.getByTestId('revocation-panel');
    await expect(panel).toHaveAttribute('data-status', 'REVOKED');
    await expect(approving.getByTestId('revocation-final')).toContainText('Issued in error (code 2)');
  });

  await test.step('each recipient is told that version 1 is withdrawn, with the reason and nothing else (#96)', async () => {
    test.skip(!admin.email, 'needs SEED_ADMIN_* (see CI)');
    if (!process.env.SMTP_URL && !process.env.CI) return;
    runMailerOnce();
    const english = (await mailTo(recipients.en)).find((m) => m.Subject.includes('is withdrawn'));
    const bulgarian = (await mailTo(recipients.bg)).find((m) => m.Subject.includes('е оттеглена'));
    expect(english?.Subject).toContain('version 1 of the audit report for Example Manufacturing AD is withdrawn');
    expect(english?.Text).toContain('Reason given: Issued in error.');
    expect(bulgarian?.Text).toContain('Посочена причина: Издаден по грешка.');
    for (const message of [english!, bulgarian!]) {
      expect(message.Attachments).toEqual([]);
      expect(message.HTML).toBe('');
      expect(message.Text).toContain(`E2E-${tag}`);
      // The reason's label, never the note the admin typed.
      expect(message.Text).not.toContain('Issued against the wrong period.');
      for (const text of ['In our opinion', 'except for', 'Qualified', 'IFRS', 'financial position', '31 December']) {
        expect(message.Text).not.toContain(text);
      }
    }
    await prepared.goto(engagementUrl);
    for (const badge of await prepared.getByTestId('recipient-last').all()) {
      await expect(badge).toHaveAttribute('data-kind', 'REVOKED');
      await expect(badge).toContainText('Withdrawal of version 1: sent');
    }
  });

  await test.step('the verifier reports version 1’s copy and original as revoked, and version 2 as the latest', async () => {
    test.skip(!admin.email, 'needs SEED_ADMIN_* (see CI)');
    await visitor.goto('/verify');
    for (const file of [copy, uniquePdf('en-unmodified.pdf', tag)]) {
      await visitor.getByTestId('verify-file').setInputFiles({ name: 'report.pdf', mimeType: 'application/pdf', buffer: file });
      await expect(visitor.getByTestId('verdict')).toHaveAttribute('data-kind', 'REVOKED', { timeout: 30_000 });
      await visitor.getByTestId('verify-another').click();
      await expect(visitor.getByTestId('verdict')).toHaveCount(0);
    }
    // Version 2 stands: revoking version 1 says nothing about it.
    await visitor.getByTestId('verify-file').setInputFiles({ name: 'report.pdf', mimeType: 'application/pdf', buffer: uniquePdf('en-qualified.pdf', tag) });
    await expect(visitor.getByTestId('verdict')).toHaveAttribute('data-kind', 'AUTHENTIC_LATEST', { timeout: 30_000 });
  });

  await test.step('the console says while the worker’s two endpoints disagree, and the worker clears it once they agree (#92)', async () => {
    // As a pass in which they disagreed leaves it.
    await withDb((db) => db.query('UPDATE "IssuerKeyStatus" SET "rpcDisagreedAt" = $1', [new Date('2026-01-02T03:04:00Z')]));
    await prepared.goto('/dashboard');
    await expect(prepared.getByTestId('rpc-disagree')).toContainText('have disagreed about the chain since Jan 2, 2026');
    // The worker reads both (here the one local node, twice), they agree, and the banner goes.
    await runWorkerOnce();
    await prepared.reload();
    await expect(prepared.getByTestId('rpc-disagree')).toHaveCount(0);
  });

  expect(cspViolations()).toEqual([]);
});
