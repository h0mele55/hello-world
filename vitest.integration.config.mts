import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Integration tests start real processes (Anvil). They need Foundry on PATH.
export default defineConfig({
  resolve: {
    alias: {
      '@inflect/ui': fileURLToPath(new URL('./vendor/inflect-ui/src', import.meta.url)),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
