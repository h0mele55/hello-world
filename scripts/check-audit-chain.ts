/**
 * The nightly audit-chain check (#57): re-derives every firm's audit chain,
 * holds it to the last intact check, records the result (which the console
 * shows), and logs an error line and exits 1 on any break, so the scheduler
 * that runs it alerts.
 *
 *   npm run audit:check
 *
 * Run it once a day, e.g. from cron: `17 2 * * * cd /srv/app && npm run audit:check`.
 * Reads DATABASE_URL only.
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import { checkAllAuditChains } from '../src/lib/audit-check';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error(JSON.stringify({ level: 'error', message: 'audit-check refused: DATABASE_URL is not set' }));
    process.exit(2);
  }
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  try {
    const results = await checkAllAuditChains(prisma);
    for (const { orgId, outcome } of results) {
      if (outcome.ok) console.log(JSON.stringify({ level: 'info', message: 'audit chain intact', orgId, count: outcome.count, head: outcome.head }));
      else console.error(JSON.stringify({ level: 'error', message: 'AUDIT CHAIN BROKEN', orgId, seq: outcome.seq, reason: outcome.reason }));
    }
    if (results.some((r) => !r.outcome.ok)) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ level: 'error', message: 'audit-check stopped', error: error instanceof Error ? error.name : typeof error }));
  process.exit(2);
});
