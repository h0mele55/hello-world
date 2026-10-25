/**
 * Holds the firm's database to the chain (#111, src/lib/anchoring/reconcile.ts):
 * re-derives every version's state from the registry at one finalized block
 * two endpoints agree on, and prints one DIFFERENCE line for each thing the
 * database and the chain disagree on, then exits 1. Run it after a restore
 * (docs/runbooks/restore.md, step 5), with the worker stopped; run it any
 * time to check that the console says what the chain says.
 *
 *   npm run reconcile:chain
 *
 * Reads, from the environment:
 *   DATABASE_URL
 *   ANCHOR_NETWORK      a network in src/lib/chain/networks.ts, and both
 *                       <NETWORK>_RPC_URL and <NETWORK>_RPC_URL_2
 *   DEPLOYMENT_FILE     optional; a deployment record other than deployments/<network>.json
 *
 * It holds no key, sends nothing and writes nothing to the database. The firm
 * is the one the deployment record names (issuer.orgName).
 */
import fs from 'node:fs';
import path from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { createPublicClient, http, type PublicClient } from 'viem';
import { z } from 'zod';
import { PrismaClient } from '../src/generated/prisma/client';
import { reconcileWithChain } from '../src/lib/anchoring/reconcile';
import { orgIdFor } from '../src/lib/chain/deploy';
import { ChainError } from '../src/lib/chain/errors';
import { deploymentPath, isNetworkName, loadDeploymentFile, NETWORKS, rpcUrlFor, secondRpcUrlFor } from '../src/lib/chain/networks';

function refuse(message: string): never {
  console.error(JSON.stringify({ level: 'error', message: `reconcile-chain refused: ${message}` }));
  process.exit(2);
}

const DeploymentRecord = z.object({
  deployBlock: z.number().int().nonnegative().optional(),
  issuer: z.object({ orgId: z.string().regex(/^0x[0-9a-fA-F]{64}$/), orgName: z.string().min(1) }),
});

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) refuse('DATABASE_URL is not set');
  const network = process.env.ANCHOR_NETWORK;
  if (!isNetworkName(network)) refuse(`ANCHOR_NETWORK must be one of ${Object.keys(NETWORKS).join(', ')}`);
  const file = process.env.DEPLOYMENT_FILE ? path.resolve(process.env.DEPLOYMENT_FILE) : deploymentPath(network);
  const deployment = loadDeploymentFile(network, file);
  const record = DeploymentRecord.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
  if (!record.success) refuse(`${path.basename(file)} does not name the firm (issuer.orgId, issuer.orgName)`);
  const onChainOrgId = record.data.issuer.orgId.toLowerCase() as `0x${string}`;
  if (orgIdFor(record.data.issuer.orgName).toLowerCase() !== onChainOrgId) refuse(`the deployment record's org id is not keccak256 of its org name`);
  let clients: [PublicClient, PublicClient];
  try {
    const client = (rpc: string) => createPublicClient({ chain: NETWORKS[network], transport: http(rpc) }) as PublicClient;
    clients = [client(rpcUrlFor(network)), client(secondRpcUrlFor(network))];
  } catch (error) {
    if (error instanceof ChainError) refuse(`${error.code}: ${error.message}`);
    throw error;
  }

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  try {
    const org = await prisma.issuerOrg.findFirst({ where: { name: record.data.issuer.orgName }, select: { id: true } });
    if (!org) refuse('the database holds no firm named as the deployment record names it');
    const report = await reconcileWithChain({
      prisma,
      clients,
      deployment,
      firm: { orgId: org.id, onChainOrgId },
      fromBlock: BigInt(record.data.deployBlock ?? 0),
    });
    for (const difference of report.differences) console.error(JSON.stringify({ level: 'error', message: 'DIFFERENCE BETWEEN THE DATABASE AND THE CHAIN', ...difference }));
    console.log(JSON.stringify({ level: 'info', message: 'reconciled with the chain', network, block: Number(report.block), versions: report.versions, records: report.records, differences: report.differences.length }));
    if (report.differences.length > 0) {
      console.error(JSON.stringify({ level: 'error', message: `${report.differences.length} difference(s); see docs/runbooks/restore.md` }));
      process.exitCode = 1;
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  const detail = error instanceof ChainError ? error.code : error instanceof Error ? error.name : typeof error;
  console.error(JSON.stringify({ level: 'error', message: 'reconcile-chain stopped', error: detail }));
  process.exit(2);
});
