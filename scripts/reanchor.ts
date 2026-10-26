/**
 * Re-anchoring a registry whose chain is being shut down (#65,
 * docs/runbooks/sepolia-sunset.md).
 *
 *   npx tsx scripts/reanchor.ts build <source> <target> [--out <dir>]
 *       reads every record of deployments/<source>.json's registry at one
 *       finalized block both <SOURCE>_RPC_URL and <SOURCE>_RPC_URL_2 agree on,
 *       and writes <dir>/archive.json (every record and the Merkle root) and
 *       <dir>/proofs/<recordId>.json (one record's proof each). The default
 *       <dir> is reanchor/<source>-<block>; an existing one is never written
 *       over. It prints the owner's next step: owner-call.ts record-reanchor-root.
 *
 *   npx tsx scripts/reanchor.ts check <dir> <target>
 *       holds the archive and every proof in <dir> to the root recorded in
 *       deployments/<target>.json's registry, read on <TARGET>_RPC_URL and
 *       <TARGET>_RPC_URL_2 at a finalized block they agree on. One ERROR line
 *       for each thing that does not prove, then exit 1. Needs no source chain.
 *
 * Options:
 *   --source-deployment <file>, --target-deployment <file>
 *                       instead of deployments/<network>.json
 *
 * It holds no key and sends nothing: the owner records the root.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createPublicClient, http, type PublicClient } from 'viem';
import { z } from 'zod';
import { ChainError } from '../src/lib/chain/errors';
import { deploymentPath, isNetworkName, loadDeploymentFile, NETWORKS, rpcUrlFor, secondRpcUrlFor, type NetworkName } from '../src/lib/chain/networks';
import { buildReanchorArchive } from '../src/lib/chain/reanchor-build';
import { CannotVerify, checkReanchorSet, findRecordedRoot, type CheckedSet } from '../src/lib/verify-core';

function refuse(message: string): never {
  console.error(JSON.stringify({ level: 'error', message: `reanchor refused: ${message}` }));
  process.exit(2);
}

const Hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
/** The source's own record: an older build is read as it is, held to its own bytecode. */
const SourceRecord = z.object({
  chainId: z.number().int().positive(),
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  runtimeBytecodeHash: Hex32,
  deployBlock: z.number().int().nonnegative().optional(),
  issuer: z.object({ orgName: z.string().min(1) }).optional(),
});

function clientsOf(network: NetworkName): [PublicClient, PublicClient] {
  try {
    const client = (rpc: string) => createPublicClient({ chain: NETWORKS[network], transport: http(rpc) }) as PublicClient;
    return [client(rpcUrlFor(network)), client(secondRpcUrlFor(network))];
  } catch (error) {
    if (error instanceof ChainError) refuse(`${error.code}: ${error.message}`);
    throw error;
  }
}

const readJson = (file: string): unknown => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    refuse(`${file} cannot be read as JSON`);
  }
};

async function build(source: NetworkName, target: NetworkName, values: { out?: string; 'source-deployment'?: string; 'target-deployment'?: string }) {
  if (source === target) refuse('the source and the target are the same network');
  const sourceFile = values['source-deployment'] ?? deploymentPath(source);
  const record = SourceRecord.safeParse(readJson(sourceFile));
  if (!record.success) refuse(`${sourceFile} is not a deployment record`);
  if (record.data.chainId !== NETWORKS[source].id) refuse(`${sourceFile} is for chain ${record.data.chainId}, not ${source}`);
  const targetDeployment = loadDeploymentFile(target, values['target-deployment'] ?? deploymentPath(target));

  const { archive, proofs } = await buildReanchorArchive({
    clients: clientsOf(source),
    source: { chainId: record.data.chainId, address: record.data.address as `0x${string}`, runtimeBytecodeHash: record.data.runtimeBytecodeHash as `0x${string}`, deployBlock: record.data.deployBlock ?? 0 },
    target: { chainId: targetDeployment.chainId, registry: targetDeployment.address },
    issuerNames: record.data.issuer ? [record.data.issuer.orgName] : [],
  });

  const dir = path.resolve(values.out ?? path.join('reanchor', `${source}-${archive.source.block}`));
  if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0) refuse(`${dir} already holds files; an archive is never written over`);
  fs.mkdirSync(path.join(dir, 'proofs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'archive.json'), `${JSON.stringify(archive, null, 2)}\n`);
  for (const proof of proofs) fs.writeFileSync(path.join(dir, 'proofs', `${proof.records[0].record.recordId}.json`), `${JSON.stringify(proof, null, 2)}\n`);
  console.log(
    JSON.stringify({
      level: 'info',
      message: 'archive written; the owner records its root next',
      dir: path.relative(process.cwd(), dir),
      root: archive.root,
      records: archive.records.length,
      sourceBlock: archive.source.block,
      next: `npx tsx scripts/owner-call.ts ${target} record-reanchor-root ${path.relative(process.cwd(), path.join(dir, 'archive.json'))}`,
    }),
  );
}

async function check(dir: string, target: NetworkName, values: { 'target-deployment'?: string }) {
  const deployment = loadDeploymentFile(target, values['target-deployment'] ?? deploymentPath(target));
  const clients = clientsOf(target);
  const config = { chainId: deployment.chainId, registry: deployment.address, runtimeBytecodeHash: deployment.runtimeBytecodeHash, rpcUrls: ['', ''] as const };
  let failures = 0;
  const fail = (file: string, error: unknown) => {
    failures += 1;
    const reason = error instanceof CannotVerify ? error.reason : error instanceof Error ? error.name : 'UNKNOWN';
    console.error(JSON.stringify({ level: 'error', message: 'DOES NOT PROVE', file, reason, detail: error instanceof Error ? error.message : undefined }));
  };

  let archive: CheckedSet;
  try {
    archive = checkReanchorSet(readJson(path.join(dir, 'archive.json')));
  } catch (error) {
    fail('archive.json', error);
    process.exitCode = 1;
    return;
  }
  let recorded;
  try {
    recorded = await findRecordedRoot(archive, config, clients);
  } catch (error) {
    fail('archive.json', error);
    process.exitCode = 1;
    return;
  }

  const proofDir = path.join(dir, 'proofs');
  const files = fs.existsSync(proofDir) ? fs.readdirSync(proofDir).filter((f) => f.endsWith('.json')) : [];
  const proven = new Set<string>();
  for (const file of files) {
    try {
      const proof = checkReanchorSet(readJson(path.join(proofDir, file)));
      if (proof.root !== archive.root || proof.count !== archive.count) throw new CannotVerify('REANCHOR_PROOF_INVALID', 'a proof against another root');
      const own = proof.records[0];
      if (`${own.recordId}.json` !== file) throw new CannotVerify('REANCHOR_PROOF_INVALID', 'a proof filed under another record');
      proven.add(own.recordId);
    } catch (error) {
      fail(`proofs/${file}`, error);
    }
  }
  for (const r of archive.records) if (!proven.has(r.recordId)) fail(`proofs/${r.recordId}.json`, new CannotVerify('REANCHOR_NOT_COVERED', 'no proof for this record'));

  console.log(JSON.stringify({ level: 'info', message: 'checked against the recorded root', target, index: recorded.index, recordedBlock: recorded.recordedBlock, root: archive.root, records: archive.count, proofs: files.length, failures }));
  if (failures > 0) process.exitCode = 1;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { out: { type: 'string' }, 'source-deployment': { type: 'string' }, 'target-deployment': { type: 'string' } },
  });
  const [command, a, b] = positionals;
  const networks = Object.keys(NETWORKS).join('|');
  if (command === 'build') {
    if (!isNetworkName(a) || !isNetworkName(b)) refuse(`usage: reanchor build <${networks}> <${networks}> [--out <dir>]`);
    return build(a, b, values);
  }
  if (command === 'check') {
    if (!a || !fs.existsSync(path.join(a, 'archive.json')) || !isNetworkName(b)) refuse(`usage: reanchor check <dir holding archive.json> <${networks}>`);
    return check(a, b, values);
  }
  refuse(`usage: reanchor build <source> <target> | reanchor check <dir> <target>`);
}

main().catch((error) => {
  const detail = error instanceof ChainError ? `${error.code}: ${error.message}` : error instanceof CannotVerify ? error.message : error instanceof Error ? error.name : typeof error;
  console.error(JSON.stringify({ level: 'error', message: 'reanchor stopped', error: detail }));
  process.exit(2);
});
