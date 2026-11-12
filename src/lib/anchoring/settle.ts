import type { Client as PgClient } from 'pg';
import { getAddress, keccak256, type Hash, type LocalAccount, type PublicClient } from 'viem';
import type { PrismaClient } from '@/generated/prisma/client';
import { appendAuditEvent } from '@/lib/audit';
import type { Deployment } from '@/lib/chain/deployment';
import { anyKnown, firstReceipt, hashesOfWrite, issuerLockArgs } from './chain-reads';
import { classifySendError } from './send';
import { RECORD_MISMATCH_RELEASED } from './worker';

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
 *
 * The operator is NAMED, not signed in (#140): `--operator` is whatever the
 * person at the command line typed, so the audit event records it in its data
 * as `namedOperatorId`, with no actor, and the viewer says so. What
 * authenticates the act is access to the issuer key or the database.
 */

export type ReleaseRefusal =
  | 'NOT_FOUND'
  | 'OPERATOR_NOT_APPROVER'
  | 'WRONG_ISSUER'
  | 'NOT_INDETERMINATE'
  | 'TX_ON_CHAIN_OR_KNOWN'
  | 'NONCE_NOT_NEXT'
  | 'ISSUER_LOCKED'
  | 'NOT_RECORD_MISMATCH';

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
    });
    if (!write) throw new ReleaseError('NOT_FOUND');
    const orgId = write.orgId;
    const operator = await approverOf(prisma, orgId, input.operatorEmail);
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
        actorId: null,
        // An audit-log head's events are never anchor.* (#140).
        action: write.kind === 'AUDIT_HEAD' ? 'audit_head.nonce_released' : 'anchor.nonce_released',
        subjectType: 'ChainWrite',
        subjectId: write.id,
        data: { reportVersionId: write.reportVersionId, kind: write.kind, nonce: write.nonce, txHash, stuckTxHashes: hashes, namedOperatorId: operator.id },
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

async function approverOf(prisma: PrismaClient, orgId: string, email: string) {
  const operator = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  if (!operator || operator.role !== 'APPROVER' || operator.orgId !== orgId) throw new ReleaseError('OPERATOR_NOT_APPROVER');
  return operator;
}

/**
 * The exit from a RECORD_MISMATCH hold (#140): a write whose transaction is
 * final but whose record is not what it should have written. The worker holds
 * it INDETERMINATE, which holds the issuer key, because what to make of it is
 * a person's call. An approver who has looked at it (docs/runbooks/stuck-writes.md)
 * releases it here. This touches no chain: it marks the row released, in one
 * transaction with its audit event, and the worker then reads the receipt and
 * the record again on both endpoints at an agreed finalized block. If they
 * still do not match, the write is FAILED with RECORD_MISMATCH_RESOLVED,
 * keeping its nonce and hash (its transaction used them), and the key is
 * free; an anchor or revocation returns to approval, as any failed write's.
 */
export async function releaseRecordMismatch(prisma: PrismaClient, input: { chainWriteId: string; operatorEmail: string }): Promise<{ chainWriteId: string }> {
  const write = await prisma.chainWrite.findUnique({ where: { id: input.chainWriteId } });
  if (!write) throw new ReleaseError('NOT_FOUND');
  const operator = await approverOf(prisma, write.orgId, input.operatorEmail);
  if (write.status !== 'INDETERMINATE' || write.error !== 'RECORD_MISMATCH') throw new ReleaseError('NOT_RECORD_MISMATCH');
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.chainWrite.updateMany({
      where: { id: write.id, status: 'INDETERMINATE', error: 'RECORD_MISMATCH' },
      data: { error: RECORD_MISMATCH_RELEASED },
    });
    if (count !== 1) throw new ReleaseError('NOT_RECORD_MISMATCH', 'the write changed meanwhile; look again');
    await appendAuditEvent(tx, {
      orgId: write.orgId,
      actorId: null,
      action: write.kind === 'AUDIT_HEAD' ? 'audit_head.mismatch_released' : 'anchor.mismatch_released',
      subjectType: 'ChainWrite',
      subjectId: write.id,
      data: { reportVersionId: write.reportVersionId, kind: write.kind, nonce: write.nonce, txHash: write.txHash, namedOperatorId: operator.id },
    });
  });
  return { chainWriteId: write.id };
}
