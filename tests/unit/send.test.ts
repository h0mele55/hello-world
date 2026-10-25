import { HttpRequestError, InvalidInputRpcError, RpcRequestError, TimeoutError, TransactionRejectedRpcError } from 'viem';
import { describe, expect, it } from 'vitest';
import { classifySendError } from '@/lib/anchoring/send';

/** A JSON-RPC error answer from a node, wrapped the way viem wraps it. */
const answered = (message: string, code = -32000) =>
  new InvalidInputRpcError(new RpcRequestError({ body: { method: 'eth_sendRawTransaction' }, error: { code, message }, url: 'http://node' }));

describe('classifying a send', () => {
  it('treats a node that already has the transaction as sent', () => {
    expect(classifySendError(answered('already known'))).toEqual({ kind: 'SENT' });
    expect(classifySendError(answered('known transaction: 0xabc'))).toEqual({ kind: 'SENT' });
  });

  it('names refusals that happen before the transaction enters the pool', () => {
    expect(classifySendError(answered('insufficient funds for gas * price + value: have 1000 want 2000'))).toEqual({ kind: 'REJECTED', reason: 'INSUFFICIENT_FUNDS' });
    expect(classifySendError(answered('replacement transaction underpriced'))).toEqual({ kind: 'REJECTED', reason: 'REPLACEMENT_UNDERPRICED' });
    expect(classifySendError(answered('transaction underpriced'))).toEqual({ kind: 'REJECTED', reason: 'UNDERPRICED' });
    expect(classifySendError(answered('max fee per gas less than block base fee'))).toEqual({ kind: 'REJECTED', reason: 'FEE_BELOW_BASE_FEE' });
    expect(classifySendError(answered('intrinsic gas too low'))).toEqual({ kind: 'REJECTED', reason: 'INTRINSIC_GAS_TOO_LOW' });
  });

  it('leaves to the chain what only the chain can say', () => {
    // The nonce may have been used by this very transaction.
    expect(classifySendError(answered('nonce too low', -32003))).toEqual({ kind: 'UNKNOWN', reason: 'NONCE_TOO_LOW' });
    expect(classifySendError(new TransactionRejectedRpcError(new RpcRequestError({ body: {}, error: { code: -32003, message: 'something new' }, url: 'u' })))).toEqual({
      kind: 'UNKNOWN',
      reason: 'RPC_ERROR',
    });
  });

  it('calls a send without an answer UNKNOWN, never refused', () => {
    expect(classifySendError(new HttpRequestError({ url: 'http://node', status: 502 }))).toEqual({ kind: 'UNKNOWN', reason: 'NO_RPC_ANSWER' });
    expect(classifySendError(new TimeoutError({ body: {}, url: 'http://node' }))).toEqual({ kind: 'UNKNOWN', reason: 'NO_RPC_ANSWER' });
    expect(classifySendError(new Error('socket hang up'))).toEqual({ kind: 'UNKNOWN', reason: 'NO_RPC_ANSWER' });
  });
});
