/**
 * The OpenTimestamps job (#66, src/lib/ots/job.ts): submits the manifest hash
 * of every version whose anchor is final to the OpenTimestamps calendars,
 * upgrades each proof once Bitcoin has confirmed it, and checks that block
 * against two explorers. It holds no key and writes no chain; the calendars
 * see a hash of each manifest hash and a nonce, nothing else.
 *
 *   npm run ots             # a pass every OTS_INTERVAL_MS (default 5 min)
 *   npm run ots -- --once   # one pass, then exit
 *
 *   DATABASE_URL     the app's database
 *
 * The calendars (OTS_CALENDARS) and the explorers (BITCOIN_EXPLORERS) are
 * fixed in code: a proof's pending attestation names its calendar, and only
 * those listed are ever asked.
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import { runOtsPass } from '../src/lib/ots/job';

const refuse = (message: string): never => {
  console.error(JSON.stringify({ level: 'error', message: `ots refused: ${message}` }));
  process.exit(2);
};
const env = (name: string) => process.env[name] || refuse(`${name} is not set`);
/** Passes in a row that may fail before the process gives up, for its supervisor to restart. */
const MAX_FAILED_PASSES = 20;

async function main() {
  const once = process.argv.includes('--once');
  const intervalMs = Number(process.env.OTS_INTERVAL_MS || 5 * 60_000);
  if (!Number.isInteger(intervalMs) || intervalMs < 10_000) refuse('OTS_INTERVAL_MS must be a whole number of milliseconds, at least 10000');
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: env('DATABASE_URL') }) });

  let stopping = false;
  process.once('SIGTERM', () => (stopping = true));
  process.once('SIGINT', () => (stopping = true));
  let failedPasses = 0;
  try {
    do {
      try {
        const report = await runOtsPass({ prisma });
        failedPasses = 0;
        console.log(
          JSON.stringify({
            level: report.broken.length ? 'error' : report.notSubmitted.length ? 'warn' : 'info',
            message: 'ots pass',
            submitted: report.submitted.length,
            notSubmitted: report.notSubmitted,
            complete: report.complete,
            broken: report.broken,
            pending: report.pending.length,
            reasons: [...new Set(report.pending.map((p) => p.reason).filter(Boolean))],
          }),
        );
      } catch (error) {
        // The database out for a moment must not stop the job: what is not yet timestamped stays to do.
        failedPasses += 1;
        if (once || failedPasses >= MAX_FAILED_PASSES) throw error;
        console.error(JSON.stringify({ level: 'error', message: 'ots pass failed; trying again after the interval', error: error instanceof Error ? error.name : typeof error, failedPasses }));
      }
      if (!once && !stopping) await new Promise((resolve) => setTimeout(resolve, intervalMs));
    } while (!once && !stopping);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ level: 'error', message: 'ots stopped', error: error instanceof Error ? error.name : typeof error }));
  process.exit(2);
});
