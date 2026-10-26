/**
 * The monthly checkpoint of the registry the firm anchors on (#122,
 * src/lib/anchoring/checkpoint.ts, docs/runbooks/checkpoints.md).
 *
 *   npm run checkpoint
 *       on the 1st of each month: every record the registry holds, at one
 *       finalized block both endpoints agree on, under one Merkle root, kept
 *       as the previous month's checkpoint. A second run in the month changes
 *       nothing. The OpenTimestamps job (`npm run ots`) then timestamps its
 *       root on Bitcoin.
 *
 *   npm run checkpoint -- --export <YYYY-MM> --out <dir>
 *       once that timestamp is COMPLETE, writes what is published:
 *       <dir>/checkpoint.json (every record, the root and the .ots proof),
 *       <dir>/proofs/<recordId>.json (each record's proof, with the .ots),
 *       and <dir>/head with <dir>/head.ots, for the reference client
 *       (`ots verify head.ots`). An existing directory is never written over.
 *       Exits 1 while the timestamp is not complete.
 *
 * Reads, from the environment:
 *   DATABASE_URL
 *   ANCHOR_NETWORK      a network in src/lib/chain/networks.ts, and both
 *                       <NETWORK>_RPC_URL and <NETWORK>_RPC_URL_2
 *   DEPLOYMENT_FILE     optional; a deployment record other than deployments/<network>.json
 *
 * It holds no key and sends nothing. The firm is the one the deployment
 * record names (issuer.orgName).
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { PrismaPg } from '@prisma/adapter-pg';
import { createPublicClient, http, type PublicClient } from 'viem';
import { z } from 'zod';
import { PrismaClient } from '../src/generated/prisma/client';
import { exportCheckpoint, runCheckpoint } from '../src/lib/anchoring/checkpoint';
import { orgIdFor } from '../src/lib/chain/deploy';
import { ChainError } from '../src/lib/chain/errors';
import { deploymentPath, isNetworkName, loadDeploymentFile, NETWORKS, rpcUrlFor, secondRpcUrlFor } from '../src/lib/chain/networks';

function refuse(message: string): never {
  console.error(JSON.stringify({ level: 'error', message: `checkpoint refused: ${message}` }));
  process.exit(2);
}

const DeploymentRecord = z.object({
  deployBlock: z.number().int().nonnegative().optional(),
  issuer: z.object({ orgId: z.string().regex(/^0x[0-9a-fA-F]{64}$/), orgName: z.string().min(1) }),
});

async function main() {
  const { values } = parseArgs({ options: { export: { type: 'string' }, out: { type: 'string' } } });
  const url = process.env.DATABASE_URL;
  if (!url) refuse('DATABASE_URL is not set');
  const network = process.env.ANCHOR_NETWORK;
  if (!isNetworkName(network)) refuse(`ANCHOR_NETWORK must be one of ${Object.keys(NETWORKS).join(', ')}`);
  const file = process.env.DEPLOYMENT_FILE ? path.resolve(process.env.DEPLOYMENT_FILE) : deploymentPath(network);
  const deployment = loadDeploymentFile(network, file);
  const record = DeploymentRecord.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
  if (!record.success) refuse(`${path.basename(file)} does not name the firm (issuer.orgId, issuer.orgName)`);
  const name = record.data.issuer.orgName;
  if (orgIdFor(name).toLowerCase() !== record.data.issuer.orgId.toLowerCase()) refuse(`the deployment record's org id is not keccak256 of its org name`);
  if (values.export !== undefined && !/^\d{4}-(0[1-9]|1[0-2])$/.test(values.export)) refuse('--export takes a month, YYYY-MM');
  if (values.export !== undefined && !values.out) refuse('--export needs --out <dir>');

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  try {
    const org = await prisma.issuerOrg.findFirst({ where: { name }, select: { id: true } });
    if (!org) refuse('the database holds no firm named as the deployment record names it');

    if (values.export !== undefined) {
      const out = path.resolve(values.out!);
      if (fs.existsSync(out) && fs.readdirSync(out).length > 0) refuse(`${out} already holds files; a checkpoint is never written over`);
      const ready = await exportCheckpoint(prisma, { orgId: org.id, chainId: deployment.chainId, registry: deployment.address, period: values.export });
      if (ready.status === 'UNKNOWN') refuse(`there is no checkpoint for ${values.export} on ${network}`);
      if (ready.status === 'NOT_YET') {
        console.error(JSON.stringify({ level: 'error', message: `the checkpoint for ${values.export} is not on Bitcoin yet: published only once it is`, reason: ready.reason, runbook: 'docs/runbooks/checkpoints.md' }));
        process.exitCode = 1;
        return;
      }
      fs.mkdirSync(path.join(out, 'proofs'), { recursive: true });
      fs.writeFileSync(path.join(out, 'checkpoint.json'), `${JSON.stringify(ready.checkpoint, null, 2)}\n`);
      for (const proof of ready.proofs) fs.writeFileSync(path.join(out, 'proofs', `${proof.records[0].record.recordId}.json`), `${JSON.stringify(proof, null, 2)}\n`);
      fs.writeFileSync(path.join(out, 'head'), ready.head);
      fs.writeFileSync(path.join(out, 'head.ots'), ready.ots);
      console.log(JSON.stringify({ level: 'info', message: 'checkpoint exported; publish the directory', period: values.export, dir: path.relative(process.cwd(), out), root: ready.checkpoint.root, records: ready.checkpoint.records.length, bitcoinHeight: ready.bitcoinHeight }));
      return;
    }

    let clients: [PublicClient, PublicClient];
    try {
      const client = (rpc: string) => createPublicClient({ chain: NETWORKS[network], transport: http(rpc) }) as PublicClient;
      clients = [client(rpcUrlFor(network)), client(secondRpcUrlFor(network))];
    } catch (error) {
      if (error instanceof ChainError) refuse(`${error.code}: ${error.message}`);
      throw error;
    }
    const outcome = await runCheckpoint({
      prisma,
      clients,
      deployment: { chainId: deployment.chainId, address: deployment.address, runtimeBytecodeHash: deployment.runtimeBytecodeHash, deployBlock: record.data.deployBlock ?? 0 },
      firm: { orgId: org.id, name },
    });
    console.log(JSON.stringify({ level: 'info', message: 'checkpoint', network, ...outcome }));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  const detail = error instanceof ChainError ? error.code : error instanceof Error ? error.name : typeof error;
  console.error(JSON.stringify({ level: 'error', message: 'checkpoint stopped', error: detail }));
  process.exit(2);
});
