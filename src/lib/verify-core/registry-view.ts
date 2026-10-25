import { createPublicClient, http, keccak256, type Address, type Hash, type Hex, type PublicClient } from 'viem';
import { ChainError } from '../chain/errors';
import { decodeRecord, ZERO_HASH, type RawRecord, type RegistryRecord } from '../chain/records';
import { registryAbi } from '../chain/registry-artifact';

/**
 * The verifier's read-only view of the registry, through two independent RPC
 * endpoints (CLAUDE.md rule 7). Each endpoint must report the expected chain
 * and hold the expected contract code. Every read is made on both, at the
 * same finalized block, and must agree; anything else is a CannotVerify with
 * a named reason, never a verdict. Isomorphic: no server imports.
 */

export interface VerifierConfig {
  chainId: number;
  registry: Address;
  /** keccak256 of the registry's runtime bytecode, from the deployment record. */
  runtimeBytecodeHash: Hex;
  rpcUrls: readonly [string, string];
}

export type CannotVerifyReason = 'RPC_UNREACHABLE' | 'WRONG_CHAIN' | 'WRONG_CONTRACT' | 'RPC_DISAGREE' | 'CHAIN_INCONSISTENT';

export class CannotVerify extends Error {
  constructor(
    readonly reason: CannotVerifyReason,
    detail?: string,
  ) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'CannotVerify';
  }
}

export interface RegistryView {
  /** The finalized block every answer is read at. */
  blockNumber: bigint;
  getRecord(recordId: Hex): Promise<RegistryRecord | null>;
  findByDocHash(docHash: Hex): Promise<RegistryRecord | null>;
  latestOf(familyId: Hex): Promise<RegistryRecord | null>;
  /** The org id a key is registered for, or null. */
  issuerOrg(issuer: Address): Promise<Hex | null>;
  /** Unix seconds. */
  blockTime(blockNumber: bigint): Promise<number>;
  /** The transaction whose Anchored event created a record. */
  anchoringTx(recordId: Hex, blockNumber: bigint): Promise<Hash | null>;
}

const stable = (value: unknown) => JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? `${v}n` : v));

/** Runs one read on both clients; refuses unless both answer, and answer alike. */
async function both<T>(clients: readonly PublicClient[], read: (client: PublicClient) => Promise<T>): Promise<T> {
  let answers: T[];
  try {
    answers = await Promise.all(clients.map(read));
  } catch (error) {
    throw new CannotVerify('RPC_UNREACHABLE', error instanceof Error ? error.name : undefined);
  }
  if (answers.some((answer) => stable(answer) !== stable(answers[0]))) throw new CannotVerify('RPC_DISAGREE');
  return answers[0];
}

export function clientsFor(config: VerifierConfig): [PublicClient, PublicClient] {
  const make = (url: string) => createPublicClient({ transport: http(url, { timeout: 10_000, retryCount: 1 }) }) as PublicClient;
  return [make(config.rpcUrls[0]), make(config.rpcUrls[1])];
}

export async function openRegistryView(config: VerifierConfig, clients: readonly PublicClient[] = clientsFor(config)): Promise<RegistryView> {
  if (clients.length !== 2) throw new CannotVerify('RPC_UNREACHABLE', 'two endpoints are required');
  // Each endpoint is checked on its own: one on the wrong chain is a refusal even if the other is right.
  let checks: { chainId: number; code: Hex | undefined; finalized: bigint }[];
  try {
    checks = await Promise.all(
      clients.map(async (client) => ({
        chainId: await client.getChainId(),
        code: await client.getCode({ address: config.registry, blockTag: 'finalized' }),
        finalized: (await client.getBlock({ blockTag: 'finalized' })).number,
      })),
    );
  } catch (error) {
    throw new CannotVerify('RPC_UNREACHABLE', error instanceof Error ? error.name : undefined);
  }
  if (checks.some((c) => c.chainId !== config.chainId)) throw new CannotVerify('WRONG_CHAIN');
  if (checks.some((c) => !c.code || keccak256(c.code) !== config.runtimeBytecodeHash)) throw new CannotVerify('WRONG_CONTRACT');
  // Read both at the older of their finalized blocks, so they answer about the same state.
  const blockNumber = checks.map((c) => c.finalized).reduce((a, b) => (a < b ? a : b));
  const at = { blockNumber } as const;
  const address = config.registry;

  async function getRecord(recordId: Hex): Promise<RegistryRecord | null> {
    const raw = await both(clients, (c) => c.readContract({ address, abi: registryAbi, functionName: 'getRecord', args: [recordId], ...at }));
    try {
      return decodeRecord(recordId, raw as RawRecord);
    } catch (error) {
      // A record this build cannot read (an unknown kind) is refused, not guessed at.
      if (error instanceof ChainError) throw new CannotVerify('CHAIN_INCONSISTENT', error.code);
      throw error;
    }
  }

  return {
    blockNumber,
    getRecord,
    async findByDocHash(docHash) {
      const recordId = await both(clients, (c) => c.readContract({ address, abi: registryAbi, functionName: 'recordOfDoc', args: [docHash], ...at }));
      return recordId === ZERO_HASH ? null : getRecord(recordId);
    },
    async latestOf(familyId) {
      const recordId = await both(clients, (c) => c.readContract({ address, abi: registryAbi, functionName: 'latestOf', args: [familyId], ...at }));
      return recordId === ZERO_HASH ? null : getRecord(recordId);
    },
    async issuerOrg(issuer) {
      const [orgId] = await both(clients, (c) => c.readContract({ address, abi: registryAbi, functionName: 'issuers', args: [issuer], ...at }));
      return orgId === ZERO_HASH ? null : orgId;
    },
    async blockTime(block) {
      const timestamp = await both(clients, async (c) => (await c.getBlock({ blockNumber: block })).timestamp);
      return Number(timestamp);
    },
    async anchoringTx(recordId, block) {
      const hashes = await both(clients, async (c) =>
        (await c.getContractEvents({ address, abi: registryAbi, eventName: 'Anchored', args: { recordId }, fromBlock: block, toBlock: block })).map((e) => e.transactionHash),
      );
      return hashes[0] ?? null;
    },
  };
}
