/**
 * The registry watch (#93): reports every write on chain by one of the firm's
 * issuer keys that the journal did not make, a revocation above all. It
 * records each in the database (the console shows them until an admin has
 * reviewed them), logs an error line for each new one, and exits 1 while any
 * is open, so the scheduler that runs it alerts.
 *
 *   npm run watch:registry
 *
 * Run it often: a revocation it reports must be cancelled by the owner before
 * it takes effect (docs/runbooks/stolen-issuer-key.md). Every ten minutes from
 * cron, e.g. `*\/10 * * * * cd /srv/app && npm run watch:registry`.
 *
 * Reads, from the environment:
 *   DATABASE_URL
 *   ANCHOR_NETWORK      a network in src/lib/chain/networks.ts, and its <NETWORK>_RPC_URL
 *                       and <NETWORK>_RPC_URL_2, from different providers: every read must agree on both (#141)
 *   DEPLOYMENT_FILE     optional; a deployment record other than deployments/<network>.json
 *
 * It holds no key and sends nothing. The firm is the one whose name the
 * deployment record registered (issuer.orgName); a firm the database does not
 * hold under that name is a refusal, never a quiet "nothing found".
 */
import fs from 'node:fs';
import path from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { createPublicClient, http, type PublicClient } from 'viem';
import { z } from 'zod';
import { PrismaClient } from '../src/generated/prisma/client';
import { watchRegistry } from '../src/lib/anchoring/registry-watch';
import { orgIdFor } from '../src/lib/chain/deploy';
import { ChainError } from '../src/lib/chain/errors';
import { deploymentPath, isNetworkName, loadDeploymentFile, logRangeFor, NETWORKS, rpcUrlFor, secondRpcUrlFor } from '../src/lib/chain/networks';

function refuse(message: string): never {
  console.error(JSON.stringify({ level: 'error', message: `watch-registry refused: ${message}` }));
  process.exit(2);
}

const DeploymentRecord = z.object({
  // Required: without it every scan of the registry's events would start at genesis (#142).
  deployBlock: z.number().int().nonnegative(),
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
  if (!record.success) refuse(`${path.basename(file)} does not name the firm (issuer.orgId, issuer.orgName) and the block the registry was deployed in (deployBlock)`);
  const onChainOrgId = record.data.issuer.orgId.toLowerCase() as `0x${string}`;
  if (orgIdFor(record.data.issuer.orgName).toLowerCase() !== onChainOrgId) refuse(`the deployment record's org id is not keccak256 of its org name`);

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  try {
    const org = await prisma.issuerOrg.findFirst({ where: { name: record.data.issuer.orgName }, select: { id: true } });
    if (!org) refuse(`the database holds no firm named as the deployment record names it`);
    const client = (rpc: string) => createPublicClient({ chain: NETWORKS[network], transport: http(rpc) }) as PublicClient;
    let second: string;
    try {
      second = secondRpcUrlFor(network);
    } catch (error) {
      if (error instanceof ChainError) refuse(`${error.code}: ${error.message}`);
      throw error;
    }
    const first = rpcUrlFor(network);
    const one = client(first);
    const report = await watchRegistry({
      prisma,
      // One endpoint on a local chain without a second: the same client twice.
      clients: second === first ? [one, one] : [one, client(second)],
      deployment,
      firm: { orgId: org.id, onChainOrgId },
      fromBlock: BigInt(record.data.deployBlock),
      rangeBlocks: logRangeFor(network),
    });
    for (const finding of report.found) {
      console.error(
        JSON.stringify({
          level: 'error',
          message: 'A WRITE BY THE FIRM’S ISSUER KEY THAT THE JOURNAL DID NOT MAKE',
          kind: finding.kind,
          recordId: finding.recordId,
          txHash: finding.txHash,
          blockNumber: Number(finding.blockNumber),
          issuer: finding.issuer,
          ...(finding.effectiveAt === null ? {} : { takesEffect: new Date(finding.effectiveAt * 1000).toISOString(), runbook: 'docs/runbooks/stolen-issuer-key.md' }),
        }),
      );
    }
    console.log(JSON.stringify({ level: 'info', message: 'registry watched', network, from: Number(report.from), to: Number(report.to), seen: report.seen, found: report.found.length, open: report.open }));
    if (report.open > 0) {
      console.error(JSON.stringify({ level: 'error', message: `${report.open} unjournaled write(s) not yet reviewed; see the console's audit log` }));
      process.exitCode = 1;
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  const detail = error instanceof ChainError ? error.code : error instanceof Error ? error.name : typeof error;
  console.error(JSON.stringify({ level: 'error', message: 'watch-registry stopped', error: detail }));
  process.exit(2);
});
