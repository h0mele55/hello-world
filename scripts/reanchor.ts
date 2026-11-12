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
 *   npx tsx scripts/reanchor.ts check <dir> <target> (--source <network> | --source-gone)
 *       holds the archive and every proof in <dir> to the root recorded in
 *       deployments/<target>.json's registry, read on <TARGET>_RPC_URL and
 *       <TARGET>_RPC_URL_2 at a finalized block they agree on; and, with
 *       --source, the archive to what the source registry held at the
 *       archive's block, read again on <SOURCE>_RPC_URL and _2 (#155).
 *       --source-gone says, once the source chain is shut down, that this
 *       comparison can no longer be made. One ERROR line for each thing that
 *       does not prove, then exit 1.
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
import { ChainError } from '../src/lib/chain/errors';
import { deploymentPath, isNetworkName, loadDeploymentFile, NETWORKS, rpcUrlFor, secondRpcUrlFor, type NetworkName } from '../src/lib/chain/networks';
import { buildReanchorArchive, checkArchiveAgainstSource } from '../src/lib/chain/reanchor-build';
import { CannotVerify, checkReanchorSet, findRecordedRoot, type CheckedSet } from '../src/lib/verify-core';
import { sourceReadDeps } from './reanchor-source';

function refuse(message: string): never {
  console.error(JSON.stringify({ level: 'error', message: `reanchor refused: ${message}` }));
  process.exit(2);
}

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
  const deps = sourceReadDeps(source, values['source-deployment']);
  if (typeof deps === 'string') refuse(deps);
  const targetDeployment = loadDeploymentFile(target, values['target-deployment'] ?? deploymentPath(target));

  const { archive, proofs } = await buildReanchorArchive({ ...deps, target: { chainId: targetDeployment.chainId, registry: targetDeployment.address } });

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
      next: `npx tsx scripts/owner-call.ts ${target} record-reanchor-root ${path.relative(process.cwd(), path.join(dir, 'archive.json'))} --source ${source}`,
    }),
  );
}

async function check(dir: string, target: NetworkName, values: { source?: string; 'source-gone'?: boolean; 'source-deployment'?: string; 'target-deployment'?: string }) {
  const source = sourceChoice(values);
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
  // What the source held at the archive's block, while it can still be read (#155).
  if (source) {
    const deps = sourceReadDeps(source, values['source-deployment']);
    if (typeof deps === 'string') refuse(deps);
    try {
      await checkArchiveAgainstSource(deps, archive);
    } catch (error) {
      fail('archive.json', error instanceof ChainError ? Object.assign(new Error(error.message), { name: error.code }) : error);
      process.exitCode = 1;
      return;
    }
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

  console.log(JSON.stringify({ level: 'info', message: 'checked against the recorded root', target, index: recorded.index, recordedBlock: recorded.recordedBlock, root: archive.root, records: archive.count, proofs: files.length, failures, sourceChecked: source !== null }));
  if (failures > 0) process.exitCode = 1;
}

/**
 * Which network the archive is compared with, or null when the person said
 * its chain is gone: one of the two is required, so the comparison is never
 * skipped by leaving a flag out (#155).
 */
function sourceChoice(values: { source?: string; 'source-gone'?: boolean }): NetworkName | null {
  if (values.source && values['source-gone']) refuse('give --source or --source-gone, not both');
  if (values['source-gone']) {
    console.error(JSON.stringify({ level: 'warn', message: 'the archive is NOT compared with its source registry: --source-gone says its chain is shut down' }));
    return null;
  }
  if (!values.source) refuse('give --source <network>, the chain the archive was read from, so it is compared with what that registry held; or --source-gone once that chain is shut down');
  if (!isNetworkName(values.source)) refuse(`--source ${values.source} is not a network`);
  return values.source;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { out: { type: 'string' }, source: { type: 'string' }, 'source-gone': { type: 'boolean', default: false }, 'source-deployment': { type: 'string' }, 'target-deployment': { type: 'string' } },
  });
  const [command, a, b] = positionals;
  const networks = Object.keys(NETWORKS).join('|');
  if (command === 'build') {
    if (!isNetworkName(a) || !isNetworkName(b)) refuse(`usage: reanchor build <${networks}> <${networks}> [--out <dir>]`);
    return build(a, b, values);
  }
  if (command === 'check') {
    if (!a || !fs.existsSync(path.join(a, 'archive.json')) || !isNetworkName(b)) refuse(`usage: reanchor check <dir holding archive.json> <${networks}> (--source <network> | --source-gone)`);
    return check(a, b, values);
  }
  refuse(`usage: reanchor build <source> <target> | reanchor check <dir> <target>`);
}

main().catch((error) => {
  const detail = error instanceof ChainError ? `${error.code}: ${error.message}` : error instanceof CannotVerify ? error.message : error instanceof Error ? error.name : typeof error;
  console.error(JSON.stringify({ level: 'error', message: 'reanchor stopped', error: detail }));
  process.exit(2);
});
