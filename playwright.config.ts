import os from 'node:os';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const PORT = 3100;

// The roots of the firm's electronic seal (#120), which /verify hands the
// browser. tests/e2e/anchoring.spec.ts writes them here when it makes the
// stand-in provider's keys; the server reads the file on every render.
process.env.E2E_SEAL_ROOTS ??= path.join(os.tmpdir(), 'anchor-e2e-seal-roots.pem');

// Where the single-file verifier is published (#85): /verify links it, and the
// worker the anchoring test runs names it on certificates.
process.env.STANDALONE_VERIFIER_URL ??= 'https://verifier.example/audit-anchor/';

// The app's server never holds the issuer key: only the worker does
// (scripts/worker.ts, run by tests/e2e/anchoring.spec.ts as its own process).
const serverEnv = {
  ...(Object.fromEntries(Object.entries(process.env).filter(([name, value]) => name !== 'ISSUER_PRIVATE_KEY' && value !== undefined)) as Record<string, string>),
  // Tests address the lookup rate limit per client through X-Forwarded-For, as a trusted proxy would set it.
  TRUST_PROXY_HEADERS: '1',
  SEAL_TRUST_ANCHORS: process.env.E2E_SEAL_ROOTS,
};

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    // A Chromium already on the machine, when its build differs from the
    // one this Playwright version downloads.
    ...(process.env.PW_CHROMIUM_PATH ? { launchOptions: { executablePath: process.env.PW_CHROMIUM_PATH } } : {}),
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // Runs against the production build, so a class Tailwind failed to
    // generate shows up here exactly as it would for a user.
    command: `npx next start -p ${PORT}`,
    url: `http://127.0.0.1:${PORT}`,
    env: serverEnv,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
