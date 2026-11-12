import type { CoverageOptions } from 'vitest/node';

/**
 * Coverage for one suite (#149), collected only when it runs with
 * `--coverage`: into coverage/<suite>, as a summary on the console, a JSON
 * summary CI writes into the run's summary, and an HTML report CI keeps.
 */
export const coverageFor = (suite: string): CoverageOptions => ({
  provider: 'v8',
  include: ['src/**/*.{ts,tsx,mjs}', 'scripts/**/*.{ts,mjs}', 'standalone/**/*.ts'],
  exclude: ['src/generated/**', 'src/lib/chain/registry-artifact.ts'],
  reporter: ['text-summary', 'json-summary', 'html'],
  reportsDirectory: `coverage/${suite}`,
});
