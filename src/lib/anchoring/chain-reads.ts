import { TransactionNotFoundError, TransactionReceiptNotFoundError, type Address, type Hash, type PublicClient, type TransactionReceipt } from 'viem';
import { ADVISORY_LOCK_CLASS } from '@/lib/audit';

/**
 * Chain reads the worker and the operator tools share, so both judge a
 * journal row's transaction the same way.
 */

export async function receiptOf(client: PublicClient, hash: Hash): Promise<TransactionReceipt | null> {
  try {
    return await client.getTransactionReceipt({ hash });
  } catch (error) {
    if (error instanceof TransactionReceiptNotFoundError) return null;
    throw error;
  }
}

export async function firstReceipt(client: PublicClient, hashes: Hash[]): Promise<TransactionReceipt | null> {
  for (const hash of hashes) {
    const receipt = await receiptOf(client, hash);
    if (receipt) return receipt;
  }
  return null;
}

/** Whether the node knows any of the hashes, mined or still in its pool. */
export async function anyKnown(client: PublicClient, hashes: Hash[]): Promise<boolean> {
  for (const hash of hashes) {
    try {
      await client.getTransaction({ hash });
      return true;
    } catch (error) {
      if (!(error instanceof TransactionNotFoundError)) throw error;
    }
  }
  return false;
}

/** Every hash a journal row has had: its current one and those it replaced. */
export const hashesOfWrite = (write: { txHash: string | null; replacedTxHashes: string[] }) =>
  [write.txHash, ...write.replacedTxHashes].filter((h): h is string => !!h) as Hash[];

/** Arguments for pg_(try_)advisory_lock / pg_advisory_unlock on one issuer key: one writer per key. */
export const issuerLockArgs = (chainId: number, issuer: Address): [number, string] => [ADVISORY_LOCK_CLASS.ISSUER_KEY, `${chainId}:${issuer.toLowerCase()}`];
