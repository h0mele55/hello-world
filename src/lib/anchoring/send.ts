import { BaseError, RpcRequestError } from 'viem';

/**
 * What `eth_sendRawTransaction` told us. Only two answers are certain: the
 * node took the bytes (or already had them), or it refused them before they
 * reached its pool. Everything else, a timeout or a dropped connection
 * included, is UNKNOWN and the write becomes INDETERMINATE (CLAUDE.md rule 3).
 */
export type SendOutcome = { kind: 'SENT' } | { kind: 'REJECTED'; reason: string } | { kind: 'UNKNOWN'; reason: string };

/** Refusals a node gives before a transaction enters its pool. Matched on the node's own message. */
const REJECTIONS: readonly [RegExp, string][] = [
  [/replacement transaction underpriced/i, 'REPLACEMENT_UNDERPRICED'],
  [/insufficient funds/i, 'INSUFFICIENT_FUNDS'],
  [/intrinsic gas too low/i, 'INTRINSIC_GAS_TOO_LOW'],
  [/(max fee per gas|fee cap) less than block base fee/i, 'FEE_BELOW_BASE_FEE'],
  [/transaction underpriced/i, 'UNDERPRICED'],
  [/exceeds block gas limit/i, 'GAS_LIMIT_EXCEEDED'],
];

export function classifySendError(error: unknown): SendOutcome {
  const rpc = error instanceof RpcRequestError ? error : error instanceof BaseError ? error.walk((e) => e instanceof RpcRequestError) : null;
  // No JSON-RPC answer at all: the request may or may not have arrived.
  if (!(rpc instanceof RpcRequestError)) return { kind: 'UNKNOWN', reason: 'NO_RPC_ANSWER' };
  const message = rpc.details ?? '';
  if (/already known|known transaction/i.test(message)) return { kind: 'SENT' };
  // Our nonce was used: by this very transaction, an earlier one of ours, or
  // someone else. Only the chain can say which.
  if (/nonce too low/i.test(message)) return { kind: 'UNKNOWN', reason: 'NONCE_TOO_LOW' };
  for (const [pattern, reason] of REJECTIONS) if (pattern.test(message)) return { kind: 'REJECTED', reason };
  return { kind: 'UNKNOWN', reason: 'RPC_ERROR' };
}
