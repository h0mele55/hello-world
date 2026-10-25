/**
 * The anchoring worker process: works the ChainWrite journal for one issuer
 * key (src/lib/anchoring/worker.ts).
 *
 *   npm run worker            # a pass every WORKER_INTERVAL_MS (default 15 s)
 *   npm run worker -- --once  # one pass, then exit
 *
 * Reads, from the environment only:
 *   DATABASE_URL        the app's database
 *   ANCHOR_NETWORK      sepolia or local; deployments/<network>.json names the registry
 *   ISSUER_PRIVATE_KEY  the issuer key. Read here and nowhere else: the web app never holds it.
 *   ISSUER_ADDRESS      optional; when set, must be the key's address (it is what the web app journals)
 *   SEPOLIA_RPC_URL / LOCAL_RPC_URL
 *
 * Any number of workers may run: an advisory lock lets one work a given
 * issuer key at a time.
 */
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { createPublicClient, getAddress, http, isHex, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { PrismaClient } from '../src/generated/prisma/client';
import { runWorkerPass } from '../src/lib/anchoring/worker';
import { isNetworkName, loadDeployment, NETWORKS, rpcUrlFor } from '../src/lib/chain/networks';

function fail(message: string): never {
  console.error(JSON.stringify({ level: 'error', message: `worker refused to start: ${message}` }));
  process.exit(1);
}

function env(name: string): string {
  const value = process.env[name];
  if (!value) fail(`${name} is not set`);
  return value;
}

async function main() {
  const once = process.argv.includes('--once');
  const network = env('ANCHOR_NETWORK');
  if (!isNetworkName(network)) fail('ANCHOR_NETWORK must be sepolia or local');
  const key = env('ISSUER_PRIVATE_KEY');
  if (!isHex(key) || key.length !== 66) fail('ISSUER_PRIVATE_KEY is not a 32-byte hex key');
  const account = privateKeyToAccount(key);
  const declared = process.env.ISSUER_ADDRESS;
  if (declared && getAddress(declared) !== account.address) fail('ISSUER_ADDRESS is not the address of ISSUER_PRIVATE_KEY');

  const deployment = loadDeployment(network);
  const publicClient = createPublicClient({ chain: NETWORKS[network], transport: http(rpcUrlFor(network)) }) as PublicClient;
  const databaseUrl = env('DATABASE_URL');
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl, max: 4, connectionTimeoutMillis: 10_000 }) });
  const lockClient = new pg.Client({ connectionString: databaseUrl });
  await lockClient.connect();

  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);

  const intervalMs = Number(process.env.WORKER_INTERVAL_MS ?? 15_000);
  console.log(JSON.stringify({ level: 'info', message: 'worker started', network, issuer: account.address, registry: deployment.address }));
  try {
    do {
      const report = await runWorkerPass({ prisma, lockClient, publicClient, account, deployment });
      console.log(
        JSON.stringify({
          level: 'info',
          message: 'pass',
          ran: report.ran,
          reason: report.reason,
          balanceWei: report.balanceWei?.toString(),
          lowBalance: report.lowBalance,
          steps: report.steps.length,
          errors: report.errors.length,
        }),
      );
      if (once) break;
      for (let waited = 0; waited < intervalMs && !stopping; waited += 250) await new Promise((r) => setTimeout(r, 250));
    } while (!stopping);
  } finally {
    await lockClient.end();
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  // The name only: a message can carry a request body.
  console.error(JSON.stringify({ level: 'error', message: 'worker stopped', error: error instanceof Error ? error.name : typeof error }));
  process.exit(1);
});
