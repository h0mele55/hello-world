/**
 * The nightly audit-chain check (#57, #94): re-derives every firm's audit
 * chain, holds it to the last intact check and to every head of it on chain,
 * records the result (which the console shows), queues the day's head for the
 * worker to write, and logs an error line and exits 1 on any break, so the
 * scheduler that runs it alerts.
 *
 *   npm run audit:check
 *
 * Run it once a day, e.g. from cron: `17 2 * * * cd /srv/app && npm run audit:check`.
 * Reads, from the environment:
 *   DATABASE_URL
 *   ANCHOR_NETWORK, ISSUER_ADDRESS and deployments/<network>.json (or DEPLOYMENT_FILE)
 *   <NETWORK>_RPC_URL and <NETWORK>_RPC_URL_2, from different providers (#92)
 * It holds no key; the worker writes the head it queues.
 */
import path from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { createPublicClient, getAddress, http, isAddress, type PublicClient } from 'viem';
import { PrismaClient } from '../src/generated/prisma/client';
import { registryHeadWitness } from '../src/lib/anchoring/audit-head';
import { checkAllAuditChains } from '../src/lib/audit-check';
import { ChainError } from '../src/lib/chain/errors';
import { isNetworkName, loadDeployment, loadDeploymentFile, NETWORKS, rpcUrlFor, secondRpcUrlFor } from '../src/lib/chain/networks';

function refuse(message: string): never {
  console.error(JSON.stringify({ level: 'error', message: `audit-check refused: ${message}` }));
  process.exit(2);
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) refuse('DATABASE_URL is not set');
  // The log is held to its heads on chain (#94): without the chain, the check would vouch for what the database alone says.
  const network = process.env.ANCHOR_NETWORK;
  if (!isNetworkName(network)) refuse(`ANCHOR_NETWORK must be one of ${Object.keys(NETWORKS).join(', ')}: the check reads the log's heads on chain`);
  const issuer = process.env.ISSUER_ADDRESS;
  if (!issuer || !isAddress(issuer)) refuse('ISSUER_ADDRESS is not an address');
  let clients: [PublicClient, PublicClient];
  let deployment;
  try {
    deployment = process.env.DEPLOYMENT_FILE ? loadDeploymentFile(network, path.resolve(process.env.DEPLOYMENT_FILE)) : loadDeployment(network);
    const client = (rpc: string) => createPublicClient({ chain: NETWORKS[network], transport: http(rpc) }) as PublicClient;
    clients = [client(rpcUrlFor(network)), client(secondRpcUrlFor(network))];
  } catch (error) {
    if (error instanceof ChainError) refuse(`${error.code}: ${error.message}`);
    throw error;
  }
  const target = { network, chainId: deployment.chainId, registry: getAddress(deployment.address), issuer: getAddress(issuer) };
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  try {
    const results = await checkAllAuditChains(prisma, registryHeadWitness({ clients, deployment, target }));
    for (const { orgId, outcome } of results) {
      if (outcome.ok) {
        console.log(JSON.stringify({ level: 'info', message: 'audit chain intact', orgId, count: outcome.count, head: outcome.head, chainHeads: outcome.chainHeads, queued: outcome.queued }));
      } else {
        console.error(
          JSON.stringify({
            level: 'error',
            message: 'AUDIT CHAIN BROKEN',
            orgId,
            seq: outcome.seq,
            reason: outcome.reason,
            ...(outcome.missing ? { missingHeads: outcome.missing, runbook: 'docs/runbooks/audit-head-missing.md' } : {}),
          }),
        );
      }
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
