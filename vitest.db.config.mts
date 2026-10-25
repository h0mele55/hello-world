import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Intake use cases against a real Postgres (TEST_DATABASE_URL), migrated from
// scratch by the global setup. Each test file truncates the tables it uses.
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // `server-only` throws outside a React Server Components bundle; these
      // tests import server modules on purpose.
      'server-only': fileURLToPath(new URL('./tests/helpers/empty-module.ts', import.meta.url)),
    },
  },
  test: {
    include: ['tests/db/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['tests/db/global-setup.ts'],
    setupFiles: ['tests/db/env.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
