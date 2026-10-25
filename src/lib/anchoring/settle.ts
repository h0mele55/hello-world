import type { Client as PgClient } from 'pg';
import { getAddress, keccak256, type Hash, type LocalAccount, type PublicClient } from 'viem';
import type { PrismaClient } from '@/generated/prisma/client';
import { appendAuditEvent } from '@/lib/audit';
import type { Deployment } from '@/lib/chain/deployment';
import { anyKnown, firstReceipt, hashesOfWrite, issuerLockArgs } from './chain-reads';
import { classifySendError } from './send';

/**
 * The operator's remedy for a write the worker cannot settle (#78): it is
 * INDETERMINATE, none of its transactions is mined or known to the node, and
 * the issuer's next nonce is still its nonce. Nothing can say whether its bytes
 * will ever appear, so the issuer key is held. This uses that nonce with a
 * zero-value transfer to the issuer itself; once that is final the worker reads
 * the outcome (NONCE_CONSUMED) from the chain and releases the key.
 *
 * It never resends the write: only one transaction per nonce can be mined, so
 * whichever lands decides, and the worker reads which.
 */

export type ReleaseRefusal =
  | 'NOT_FOUND'
  | 'OPERATOR_NOT_APPROVER'
  | 'WRONG_ISSUER'
  | 'NOT_INDETERMINATE'
  | 'TX_ON_CHAIN_OR_KNOWN'
  | 'NONCE_NOT_NEXT'
  | 'ISSUER_LOCKED';

export class ReleaseError extends Error {
  constructor(readonly code: ReleaseRefusal | 'SEND_REJECTED' | 'SEND_UNKNOWN', detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'ReleaseError';
  }
}

export interface ReleaseDeps {
  prisma: PrismaClient;
  lockClient: PgClient;
  publicClient: PublicClient;
  account: LocalAccount;
  deployment: Deployment;
}

const bump = (value: bigint) => (value * 125n + 99n) / 100n;
const max = (...values: bigint[]) => values.reduce((a, b) => (a > b ? a : b));

export async function releaseStuckNonce(deps: ReleaseDeps, input: { chainWriteId: string; operatorEmail: string }): Promise<{ txHash: Hash; nonce: number }> {
  const { prisma, publicClient, account, deployment } = deps;
  const lockArgs = issuerLockArgs(deployment.chainId, account.address);
  // A worker pass in flight could be assigning nonces: refuse rather than race it.
  const { rows } = await deps.lockClient.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1::int, hashtext($2)) AS locked', lockArgs);
  if (!rows[0]?.locked) throw new ReleaseError('ISSUER_LOCKED', 'a worker is working this issuer key; try again');
  try {
    const write = await prisma.chainWrite.findUnique({
      where: { id: input.chainWriteId },
      include: { reportVersion: { select: { id: true, engagement: { select: { client: { select: { orgId: true } } } } } } },
    });
    if (!write) throw new ReleaseError('NOT_FOUND');
    const orgId = write.reportVersion.engagement.client.orgId;
    const operator = await prisma.user.findUnique({ where: { email: input.operatorEmail.toLowerCase() } });
    if (!operator || operator.role !== 'APPROVER' || operator.orgId !== orgId) throw new ReleaseError('OPERATOR_NOT_APPROVER');
    if (write.chainId !== deployment.chainId || getAddress(write.registry) !== getAddress(deployment.address) || getAddress(write.issuer) !== account.address) {
      throw new ReleaseError('WRONG_ISSUER', 'the write belongs to another chain, registry or issuer key');
    }
    if (write.status !== 'INDETERMINATE' || write.nonce === null) throw new ReleaseError('NOT_INDETERMINATE');
    const hashes = hashesOfWrite(write);
    if ((await firstReceipt(publicClient, hashes)) || (await anyKnown(publicClient, hashes))) {
      throw new ReleaseError('TX_ON_CHAIN_OR_KNOWN', 'the worker settles this one by itself');
    }
    const [latest, pending] = await Promise.all([
      publicClient.getTransactionCount({ address: account.address, blockTag: 'latest' }),
      publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' }),
    ]);
    if (latest !== write.nonce || pending !== write.nonce) throw new ReleaseError('NONCE_NOT_NEXT', `the issuer's next nonce is ${pending}, the write's is ${write.nonce}`);

    // Fees above whatever the lost transaction offered, so a node holding it would take this instead.
    const fees = await publicClient.estimateFeesPerGas();
    const maxPriorityFeePerGas = max(fees.maxPriorityFeePerGas, write.maxPriorityFeePerGas ? bump(BigInt(write.maxPriorityFeePerGas)) : 0n);
    const maxFeePerGas = max(fees.maxFeePerGas, write.maxFeePerGas ? bump(BigInt(write.maxFeePerGas)) : 0n, maxPriorityFeePerGas);
    const serialized = await account.signTransaction({
      chainId: deployment.chainId,
      type: 'eip1559',
      to: account.address,
      value: 0n,
      nonce: write.nonce,
      gas: 21_000n,
      maxFeePerGas,
      maxPriorityFeePerGas,
    });
    const txHash = keccak256(serialized);

    // Journalled before it is sent, naming the person who decided to send it.
    await prisma.$transaction((tx) =>
      appendAuditEvent(tx, {
        orgId,
        actorId: operator.id,
        action: 'anchor.nonce_released',
        subjectType: 'ChainWrite',
        subjectId: write.id,
        data: { reportVersionId: write.reportVersionId, nonce: write.nonce, txHash, stuckTxHashes: hashes },
      }),
    );
    try {
      await publicClient.sendRawTransaction({ serializedTransaction: serialized });
    } catch (error) {
      const outcome = classifySendError(error);
      if (outcome.kind === 'REJECTED') throw new ReleaseError('SEND_REJECTED', outcome.reason);
      if (outcome.kind === 'UNKNOWN') throw new ReleaseError('SEND_UNKNOWN', `${outcome.reason}; check ${txHash} before trying again`);
    }
    return { txHash, nonce: write.nonce };
  } finally {
    await deps.lockClient.query('SELECT pg_advisory_unlock($1::int, hashtext($2))', lockArgs);
  }
}
