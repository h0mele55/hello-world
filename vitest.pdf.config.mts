import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// PDF tests fork the real parser process, so they are slower than unit tests
// and run on their own: golden tests on Ubuntu and Windows, fuzzing on Ubuntu.
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    include: ['tests/pdf/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
  },
});
