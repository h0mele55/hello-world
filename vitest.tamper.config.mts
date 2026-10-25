import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// The tamper suite: a real registry on Anvil, real tampering tools (qpdf,
// Chromium), and the CLI as built. Needs Foundry, qpdf and Playwright's Chromium.
export default defineConfig({
  resolve: {
    alias: {
      '@inflect/ui': fileURLToPath(new URL('./vendor/inflect-ui/src', import.meta.url)),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    include: ['tests/tamper/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
