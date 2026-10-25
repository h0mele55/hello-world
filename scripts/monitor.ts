/**
 * The monitor (#68): one line for each thing that needs a person, from the
 * journal, the worker's key status, the audit check, the registry watch and
 * the mailer (src/lib/monitor.ts), and exit 1 while there is any, so the
 * scheduler that runs it alerts whoever is on call.
 *
 *   npm run monitor
 *
 * Run it every ten minutes, e.g. `*\/10 * * * * cd /srv/app && npm run monitor`,
 * and alert on a non-zero exit. Reads DATABASE_URL only; holds no key and
 * reads no chain.
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import { collectAlerts } from '../src/lib/monitor';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error(JSON.stringify({ level: 'error', message: 'monitor refused: DATABASE_URL is not set' }));
    process.exit(2);
  }
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  try {
    const alerts = await collectAlerts(prisma);
    for (const alert of alerts) console.error(JSON.stringify({ level: 'error', message: 'ALERT', ...alert }));
    console.log(JSON.stringify({ level: 'info', message: 'monitored', alerts: alerts.length }));
    if (alerts.length) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ level: 'error', message: 'monitor stopped', error: error instanceof Error ? error.name : typeof error }));
  process.exit(2);
});
