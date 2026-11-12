import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { coverageFor } from './vitest.coverage.mts';

export default defineConfig({
  resolve: {
    alias: {
      '@inflect/ui': fileURLToPath(new URL('./vendor/inflect-ui/src', import.meta.url)),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    coverage: coverageFor('unit'),
  },
});
