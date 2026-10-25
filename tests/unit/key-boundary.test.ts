import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Phase 3 hardening: the issuer's signing key lives in the worker's
 * environment only. Nothing the web app builds (src/) reads it, so it cannot
 * be bundled for a browser or held by the web server.
 */
describe('the signing key boundary', () => {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'src', 'scripts'], { encoding: 'utf8' })
    .split('\n')
    .filter((file) => file && fs.existsSync(file));
  const mentioning = files.filter((file) => fs.readFileSync(file, 'utf8').includes('ISSUER_PRIVATE_KEY'));

  it('no file under src/ names ISSUER_PRIVATE_KEY', () => {
    expect(mentioning.filter((file) => file.startsWith('src/'))).toEqual([]);
  });

  it('only the worker script reads it', () => {
    expect(mentioning).toEqual(['scripts/worker.ts']);
  });
});
