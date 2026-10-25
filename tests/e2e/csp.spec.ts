import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { preparer, signIn } from './helpers';

/**
 * Every page carries a Content Security Policy, and every script on it the
 * nonce of its own response (#84). A page rendered once at build time would
 * carry scripts with no nonce, which the policy blocks: this test finds such
 * a page before a person does. The pages are read from git, so a new one is
 * checked without being listed here.
 */

const FAMILY_ID = `0x${'ab'.repeat(32)}`;

function pagePaths(): string[] {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'src/app'], { encoding: 'utf8' })
    .split('\n')
    .filter((f) => f.endsWith('/page.tsx'));
  return files.map((file) => {
    const segments = file
      .slice('src/app/'.length, -'page.tsx'.length)
      .split('/')
      .filter((s) => s && !/^\(.*\)$/.test(s))
      .map((s) => (s === '[familyId]' ? FAMILY_ID : s.startsWith('[') ? 'no-such-id' : s));
    return `/${segments.join('/')}`;
  });
}

const nonceOf = (csp: string) => /'nonce-([A-Za-z0-9+/=]+)'/.exec(csp)?.[1];

test('every page is served with a CSP, and each of its scripts carries that response’s nonce', async ({ page }) => {
  const paths = pagePaths();
  expect(paths).toEqual(expect.arrayContaining(['/', '/login', '/verify', '/reports', '/audit-log', `/r/${FAMILY_ID}/latest`]));
  await signIn(page, preparer);
  const nonces = new Set<string>();
  for (const path of paths) {
    const response = await page.request.get(path);
    const csp = response.headers()['content-security-policy'] ?? '';
    expect(csp, path).toContain("frame-ancestors 'none'");
    const verifier = path === '/verify' || path.startsWith('/r/');
    // Only the verifier's pages may reach beyond this origin.
    if (!verifier) expect(csp, path).toContain("connect-src 'self';");
    const nonce = nonceOf(csp);
    expect(nonce, path).toBeTruthy();
    nonces.add(nonce!);
    const scripts = (await response.text()).match(/<script\b[^>]*>/g) ?? [];
    expect(scripts.length, path).toBeGreaterThan(0);
    for (const tag of scripts) expect(tag, path).toContain(`nonce="${nonce}"`);
  }
  // A fresh nonce for every response.
  expect(nonces.size).toBe(paths.length);
});

test('the API and the files in public/ carry no page policy', async ({ request }) => {
  const worker = await request.get('/pdf.worker.min.mjs');
  expect(worker.ok()).toBe(true);
  expect(worker.headers()['content-security-policy']).toBeUndefined();
  const api = await request.get('/api/engagements');
  expect(api.headers()['content-security-policy']).toBeUndefined();
});
