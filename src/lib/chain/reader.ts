import { getAddress, keccak256, type Address, type Hash, type Hex, type PublicClient } from 'viem';
import type { Deployment } from './deployment';
import {
  BytecodeMismatchError,
  ChainMismatchError,
  NotFinalError,
  TransactionDroppedError,
  TransactionRevertedError,
} from './errors';
import { decodeRecord, ZERO_HASH, type RegistryRecord } from './records';
import { registryAbi } from './registry-artifact';

export interface FinalReceipt {
  txHash: Hash;
  blockNumber: bigint;
  blockHash: Hash;
}

/** One of a firm's audit-log heads on chain (#94), in the order written. */
export interface AuditHeadEntry {
  index: number;
  head: Hex;
  issuer: Address;
  /** Unix seconds. */
  recordedAt: number;
  /** The owner voided it: a head a stolen key wrote. The check skips it. */
  voided: boolean;
}

/** Heads read per call. */
export const AUDIT_HEAD_PAGE = 500;

export interface WaitFinalOptions {
  /** Give up after this long. Sepolia finalizes in roughly 13 minutes. */
  timeoutMs?: number;
  pollMs?: number;
}

/**
 * Read-only access to a registry deployment. Holds no key, so the Phase 4
 * browser verifier can use it as is.
 */
export function createRegistryReader(client: PublicClient, deployment: Deployment) {
  const { address } = deployment;

  /** Refuses a wrong chain or a contract that is not this build (rule 7). */
  async function assertDeployment(): Promise<void> {
    const chainId = await client.getChainId();
    if (chainId !== deployment.chainId) throw new ChainMismatchError(deployment.chainId, chainId);
    const code = await client.getCode({ address });
    if (!code || keccak256(code) !== deployment.runtimeBytecodeHash) throw new BytecodeMismatchError(address);
  }

  /**
   * The record as it stands at a block: the latest by default. Whether a
   * revocation is in effect depends on the block's time, so a caller deciding
   * that for good (rule 2) reads at the finalized block.
   */
  async function getRecord(recordId: Hex, at: { blockNumber?: bigint } = {}): Promise<RegistryRecord | null> {
    const raw = await client.readContract({ address, abi: registryAbi, functionName: 'getRecord', args: [recordId], blockNumber: at.blockNumber });
    return decodeRecord(recordId, raw);
  }

  async function findByDocHash(docHash: Hex, at: { blockNumber?: bigint } = {}): Promise<RegistryRecord | null> {
    const recordId = await client.readContract({ address, abi: registryAbi, functionName: 'recordOfDoc', args: [docHash], blockNumber: at.blockNumber });
    return recordId === ZERO_HASH ? null : getRecord(recordId, at);
  }

  async function latestOf(familyId: Hex, at: { blockNumber?: bigint } = {}): Promise<RegistryRecord | null> {
    const recordId = await client.readContract({ address, abi: registryAbi, functionName: 'latestOf', args: [familyId], blockNumber: at.blockNumber });
    return recordId === ZERO_HASH ? null : getRecord(recordId, at);
  }

  /**
   * Resolves only once the transaction's block is at or below the `finalized`
   * tag (rule 2: a transaction hash is not an anchor). After finality it reads
   * the receipt again, so a transaction re-included in another block by a
   * reorg is followed, and one that left the chain is reported.
   */
  async function waitFinal(txHash: Hash, options: WaitFinalOptions = {}): Promise<FinalReceipt> {
    const { timeoutMs = 30 * 60_000, pollMs = 12_000 } = options;
    const deadline = Date.now() + timeoutMs;
    let receipt = await client.waitForTransactionReceipt({ hash: txHash, timeout: timeoutMs, pollingInterval: pollMs });
    for (;;) {
      if (receipt.status !== 'success') throw new TransactionRevertedError(txHash);
      const finalized = await client.getBlock({ blockTag: 'finalized' });
      if (finalized.number >= receipt.blockNumber) {
        const again = await client.getTransactionReceipt({ hash: txHash }).catch(() => null);
        if (!again) throw new TransactionDroppedError(txHash);
        if (again.blockHash === receipt.blockHash) {
          return { txHash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash };
        }
        receipt = again;
        continue;
      }
      if (Date.now() + pollMs > deadline) throw new NotFinalError(txHash);
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  /** Every audit-log head of a firm (#94), voided ones included, a page at a time. */
  async function auditHeads(orgId: Hex, at: { blockNumber?: bigint } = {}): Promise<AuditHeadEntry[]> {
    const heads: AuditHeadEntry[] = [];
    for (;;) {
      const start = heads.length;
      const page = await client.readContract({ address, abi: registryAbi, functionName: 'auditHeads', args: [orgId, BigInt(start), BigInt(AUDIT_HEAD_PAGE)], blockNumber: at.blockNumber });
      page.forEach((h, i) => heads.push({ index: start + i, head: h.head, issuer: getAddress(h.issuer), recordedAt: Number(h.recordedAt), voided: h.voided }));
      if (page.length < AUDIT_HEAD_PAGE) return heads;
    }
  }

  return { deployment, assertDeployment, getRecord, findByDocHash, latestOf, auditHeads, waitFinal };
}

export type RegistryReader = ReturnType<typeof createRegistryReader>;
