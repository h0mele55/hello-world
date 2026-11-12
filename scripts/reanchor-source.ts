/**
 * The source of a re-anchoring, for scripts/reanchor.ts and
 * scripts/owner-call.ts: its deployment record and its two endpoints. A
 * problem with either is a message for the script to refuse with.
 */
import fs from 'node:fs';
import { createPublicClient, http, type Hex, type PublicClient } from 'viem';
import { z } from 'zod';
import { ChainError } from '../src/lib/chain/errors';
import { deploymentPath, logRangeFor, NETWORKS, rpcUrlFor, secondRpcUrlFor, type NetworkName } from '../src/lib/chain/networks';
import type { ReadDeps } from '../src/lib/chain/reanchor-build';

const Hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
/** The source's own record: an older build is read as it is, held to its own bytecode. */
const SourceRecord = z.object({
  chainId: z.number().int().positive(),
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  runtimeBytecodeHash: Hex32,
  // Required: without it every scan of the registry's events would start at genesis (#142).
  deployBlock: z.number().int().nonnegative(),
  issuer: z.object({ orgName: z.string().min(1) }).optional(),
});
export type SourceRecord = z.infer<typeof SourceRecord>;

export function sourceClients(network: NetworkName): [PublicClient, PublicClient] | string {
  try {
    const client = (rpc: string) => createPublicClient({ chain: NETWORKS[network], transport: http(rpc) }) as PublicClient;
    return [client(rpcUrlFor(network)), client(secondRpcUrlFor(network))];
  } catch (error) {
    if (error instanceof ChainError) return `${error.code}: ${error.message}`;
    throw error;
  }
}

export function loadSourceRecord(network: NetworkName, file = deploymentPath(network)): SourceRecord | string {
  let json: unknown;
  try {
    json = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return `${file} cannot be read as JSON`;
  }
  const record = SourceRecord.safeParse(json);
  if (!record.success) return `${file} is not a deployment record naming its deployBlock`;
  if (record.data.chainId !== NETWORKS[network].id) return `${file} is for chain ${record.data.chainId}, not ${network}`;
  return record.data;
}

/** What reading the source takes, or why it cannot be read. */
export function sourceReadDeps(network: NetworkName, file?: string): ReadDeps | string {
  const record = loadSourceRecord(network, file);
  if (typeof record === 'string') return record;
  const clients = sourceClients(network);
  if (typeof clients === 'string') return clients;
  return {
    clients,
    source: { chainId: record.chainId, address: record.address as Hex, runtimeBytecodeHash: record.runtimeBytecodeHash as Hex, deployBlock: record.deployBlock },
    issuerNames: record.issuer ? [record.issuer.orgName] : [],
    rangeBlocks: logRangeFor(network),
  };
}
