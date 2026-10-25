/**
 * The anchoring worker process: works the ChainWrite journal for one issuer
 * key (src/lib/anchoring/worker.ts).
 *
 *   npm run worker            # a pass every WORKER_INTERVAL_MS (default 15 s)
 *   npm run worker -- --once  # one pass, then exit
 *
 * Reads the issuer settings in scripts/issuer-env.ts, and also:
 *   FILE_ENCRYPTION_KEY, FILE_ENCRYPTION_KEY_VERSION, FILE_STORAGE_DIR
 *                       the same values as the app's: the worker reads originals and stores copies
 *   APP_PUBLIC_URL      the app's public origin; stamps and certificates point at <origin>/verify
 *
 * Any number of workers may run: an advisory lock lets one work a given
 * issuer key at a time. A pass that fails (an endpoint or the database out)
 * is tried again after the interval; after 20 in a row the process exits 1,
 * for its supervisor to restart.
 */
import path from 'node:path';
import { runWorkerPass } from '../src/lib/anchoring/worker';
import { createFileStore } from '../src/lib/file-store';
import { issuerEnv, refuse, requireEnv } from './issuer-env';

const fail = (message: string): never => refuse('worker', message);
/** Passes in a row that may fail before the process gives up: about five minutes at the default interval. */
const MAX_FAILED_PASSES = 20;
const env = (name: string) => requireEnv('worker', name);

async function main() {
  const once = process.argv.includes('--once');
  const keyBytes = Buffer.from(env('FILE_ENCRYPTION_KEY'), 'base64');
  if (keyBytes.length !== 32) fail('FILE_ENCRYPTION_KEY must be base64 of exactly 32 bytes');
  const keyVersion = Number(process.env.FILE_ENCRYPTION_KEY_VERSION || 1);
  if (!Number.isInteger(keyVersion) || keyVersion < 1) fail('FILE_ENCRYPTION_KEY_VERSION must be a positive integer');
  const sealingKey = { key: new Uint8Array(keyBytes), version: keyVersion };
  const files = createFileStore({ dir: path.resolve(process.env.FILE_STORAGE_DIR || 'storage'), current: sealingKey, keys: [sealingKey] });
  const verifyBaseUrl = env('APP_PUBLIC_URL');
  if (!/^https?:\/\/[^\s]+$/.test(verifyBaseUrl)) fail('APP_PUBLIC_URL must be an http(s) URL');

  const { network, account, deployment, publicClient, prisma, lockClient, close } = await issuerEnv('worker');

  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);

  const intervalMs = Number(process.env.WORKER_INTERVAL_MS || 15_000);
  if (!Number.isInteger(intervalMs) || intervalMs < 1_000) fail('WORKER_INTERVAL_MS must be a whole number of milliseconds, at least 1000');
  console.log(JSON.stringify({ level: 'info', message: 'worker started', network, issuer: account.address, registry: deployment.address }));
  let failedPasses = 0;
  try {
    do {
      let report;
      try {
        report = await runWorkerPass({ prisma, lockClient, publicClient, account, deployment, files, verifyBaseUrl });
        failedPasses = 0;
      } catch (error) {
        // An endpoint or the database out for a moment must not stop anchoring:
        // the journal holds every row's state, so the next pass resumes it. A
        // longer outage ends the process, for its supervisor to restart with
        // fresh connections (docs/runbooks/rpc-outage.md).
        failedPasses += 1;
        if (once || failedPasses >= MAX_FAILED_PASSES) throw error;
        console.error(JSON.stringify({ level: 'error', message: 'pass failed; trying again after the interval', error: error instanceof Error ? error.name : typeof error, failedPasses }));
      }
      if (report) {
        console.log(
          JSON.stringify({
            level: 'info',
            message: 'pass',
            ran: report.ran,
            reason: report.reason,
            balanceWei: report.balanceWei?.toString(),
            lowBalance: report.lowBalance,
            steps: report.steps.length,
            certified: report.certified.length,
            errors: report.errors.length,
          }),
        );
      }
      if (once) break;
      for (let waited = 0; waited < intervalMs && !stopping; waited += 250) await new Promise((r) => setTimeout(r, 250));
    } while (!stopping);
  } finally {
    await close();
  }
}

main().catch((error) => {
  // The name only: a message can carry a request body.
  console.error(JSON.stringify({ level: 'error', message: 'worker stopped', error: error instanceof Error ? error.name : typeof error }));
  process.exit(1);
});
