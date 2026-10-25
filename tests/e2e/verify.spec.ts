import { expect, test, type Page, type Request, type Route } from '@playwright/test';
import { runTag, uniquePdf } from './helpers';

/**
 * The public verifier in a real browser against a local Anvil registry. The
 * page must decide in the browser (rule 5): with the app's API answering 503
 * it still reaches a verdict, and no request it makes carries the file.
 *
 * Needs Anvil at LOCAL_RPC_URL with the registry deployed in a finalized
 * block and ANCHOR_NETWORK=local, as the anchoring test does. See the CI job.
 */

test.skip(!process.env.ANCHOR_NETWORK && !process.env.CI, 'needs a local chain (ANCHOR_NETWORK=local; see CI)');

const RPC_URL = process.env.LOCAL_RPC_URL ?? 'http://127.0.0.1:8545';
const isRpc = (url: URL) => url.origin === new URL(RPC_URL).origin;

/** Answers one JSON-RPC call in place of the node, as a cross-origin endpoint would. */
const answer = (route: Route, id: number, result: string) =>
  route.fulfill({ json: { jsonrpc: '2.0', id, result }, headers: { 'access-control-allow-origin': '*' } });

/** The JSON-RPC call a request carries, or null for a preflight. */
const callOf = (route: Route) => (route.request().method() === 'POST' ? (route.request().postDataJSON() as { id: number; method: string }) : null);

/** Every request the page makes, with its body, while the app's own API is switched off. */
async function withoutAppApi(page: Page): Promise<Request[]> {
  const requests: Request[] = [];
  page.on('request', (request) => requests.push(request));
  await page.route('**/api/**', (route) => route.fulfill({ status: 503, body: 'switched off for this test' }));
  return requests;
}

async function verify(page: Page, name: string, buffer: Buffer) {
  await page.getByTestId('verify-file').setInputFiles({ name, mimeType: 'application/pdf', buffer });
  await expect(page.getByTestId('verdict')).toBeVisible({ timeout: 30_000 });
}

test('an unregistered report is checked in the browser, with no upload and no app API', async ({ page }) => {
  const requests = await withoutAppApi(page);
  await page.goto('/verify');
  const file = uniquePdf('bg-adverse.pdf', runTag());
  await verify(page, 'report.pdf', file);
  await expect(page.getByTestId('verdict')).toHaveAttribute('data-kind', 'NOT_REGISTERED');
  await expect(page.getByTestId('verdict-body')).toContainText('carries no anchor reference');
  await expect(page.getByTestId('file-hash')).toHaveText(/^0x[0-9a-f]{64}$/);

  const sent = requests.filter((r) => r.postDataBuffer());
  expect(sent.length).toBeGreaterThan(0);
  for (const request of sent) {
    const body = request.postDataBuffer()!;
    expect(body.includes(Buffer.from('%PDF')), request.url()).toBe(false);
    expect(body.includes(file.subarray(0, 64)), request.url()).toBe(false);
    expect(request.url().startsWith(RPC_URL), request.url()).toBe(true);
  }
  expect(requests.filter((r) => new URL(r.url()).pathname.startsWith('/api/'))).toEqual([]);
});

test('an endpoint on the wrong chain, or two that disagree, give no verdict', async ({ page }) => {
  await page.goto('/verify');

  await test.step('a wrong chain id', async () => {
    await page.route(isRpc, (route) => {
      const call = callOf(route);
      return call?.method === 'eth_chainId' ? answer(route, call.id, '0x1') : route.fallback();
    });
    await verify(page, 'report.pdf', uniquePdf('en-qualified.pdf', runTag()));
    await expect(page.getByTestId('verdict')).toHaveAttribute('data-kind', 'CANNOT_VERIFY');
    await expect(page.getByTestId('verdict-body')).toContainText('different network');
    await page.unrouteAll({ behavior: 'wait' });
  });

  await test.step('two endpoints that give different answers', async () => {
    // Both local endpoints are one node: answer every second contract read differently.
    let calls = 0;
    await page.route(isRpc, (route) => {
      const call = callOf(route);
      if (call?.method !== 'eth_call' || calls++ % 2 === 0) return route.fallback();
      return answer(route, call.id, `0x${'00'.repeat(31)}01`);
    });
    await page.getByTestId('verify-another').click();
    await expect(page.getByTestId('verdict')).toHaveCount(0);
    await verify(page, 'report.pdf', uniquePdf('en-qualified.pdf', runTag()));
    await expect(page.getByTestId('verdict')).toHaveAttribute('data-kind', 'CANNOT_VERIFY');
    await expect(page.getByTestId('verdict-body')).toContainText('different answers');
  });
});

test('the verdict reads in Bulgarian', async ({ page }) => {
  await page.goto('/verify');
  await page.getByTestId('locale-bg').click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Проверка на одиторски доклад');
  await verify(page, 'доклад.pdf', uniquePdf('bg-disclaimer.pdf', runTag()));
  await expect(page.getByTestId('verdict')).toHaveAttribute('data-kind', 'NOT_REGISTERED');
  await expect(page.getByRole('heading', { level: 2 })).toHaveText('Не е регистриран');
});

test('the latest-version page refuses an id that is not one, and finds nothing for an unknown family', async ({ page }) => {
  await page.goto('/r/not-a-family/latest');
  await expect(page.getByTestId('latest-page')).toHaveAttribute('data-status', 'INVALID_ID');
  await page.goto(`/r/0x${'ab'.repeat(32)}/latest`);
  await expect(page.getByTestId('latest-page')).toHaveAttribute('data-status', 'NOT_FOUND');
  await expect(page.getByText('No anchored report has this id.')).toBeVisible();
});

test('the verifier is served with a strict CSP, and verifies under it', async ({ page }) => {
  const violations: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && /Content Security Policy/i.test(message.text())) violations.push(message.text());
  });
  const response = await page.goto('/verify');
  const csp = response?.headers()['content-security-policy'] ?? '';
  expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
  expect(csp).not.toContain("'unsafe-inline' 'nonce");
  expect(csp).toContain(`connect-src 'self' ${new URL(RPC_URL).origin}`);
  expect(csp).toContain("frame-ancestors 'none'");
  await verify(page, 'report.pdf', uniquePdf('en-adverse.pdf', runTag()));
  await expect(page.getByTestId('verdict-body')).toContainText('carries no anchor reference');
  expect(violations).toEqual([]);
});

test('the lookup page refuses a client its 61st request in a minute', async ({ request }) => {
  test.setTimeout(120_000);
  // A client address of its own (the test server trusts X-Forwarded-For), so other tests do not share its budget.
  const headers = { 'x-forwarded-for': `203.0.113.${Math.floor(Math.random() * 250) + 1}, ${runTag()}` };
  const url = `/r/0x${'cd'.repeat(32)}/latest`;
  for (let i = 0; i < 60; i++) expect((await request.get(url, { headers })).status(), `request ${i + 1}`).toBe(200);
  const refused = await request.get(url, { headers });
  expect(refused.status()).toBe(429);
  expect(Number(refused.headers()['retry-after'])).toBeGreaterThan(0);
  expect((await request.get(url, { headers: { 'x-forwarded-for': '198.51.100.250' } })).status()).toBe(200);
});
