import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// The anchoring worker against a real Postgres (TEST_DATABASE_URL, migrated by
// the database tests' global setup) and a throwaway Anvil chain. Needs Foundry
// on PATH.
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      'server-only': fileURLToPath(new URL('./tests/helpers/empty-module.ts', import.meta.url)),
    },
  },
  test: {
    include: ['tests/anchoring/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['tests/db/global-setup.ts'],
    setupFiles: ['tests/db/env.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
