import { execFileSync } from 'node:child_process';

/**
 * Applies the migrations to the test database (a fresh one in CI, so the
 * migrations are tested from scratch). The tests truncate tables, so this
 * refuses any database whose name does not end in "_test".
 */
export default function setup() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is not set');
  const name = new URL(url).pathname.replace(/^\//, '');
  if (!name.endsWith('_test')) throw new Error(`refusing to run database tests against "${name}": the name must end in _test`);
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
    shell: process.platform === 'win32',
  });
}
