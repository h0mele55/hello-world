import type { PublicClient } from 'viem';
import { ChainError } from './errors';

/**
 * Reads made on two endpoints from different providers, which must agree
 * (#92, rule 7). The worker settles journal rows on them, and the nightly
 * audit check reads the firm's audit-log heads on them (#94).
 */

const stable = (value: unknown) => JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? `${v}n` : v));

/** Both answers, which must be the same; otherwise RPC_DISAGREE, naming what they disagree about. */
export function sameOnBoth<T>(what: string, first: T, second: T): T {
  if (stable(first) !== stable(second)) throw new ChainError('RPC_DISAGREE', `the two RPC endpoints disagree about ${what}`);
  return first;
}

/** One read on both endpoints. With one endpoint (a local chain), one read. */
export async function readOnBoth<T>(clients: readonly [PublicClient, PublicClient], what: string, read: (client: PublicClient) => Promise<T>): Promise<T> {
  if (clients[0] === clients[1]) return read(clients[0]);
  const [first, second] = await Promise.all(clients.map(read));
  return sameOnBoth(what, first, second);
}

/**
 * The finalized block both endpoints have reached (the lower of the two), and
 * agree on: an endpoint that lags is waited for, never mistaken for one that
 * disagrees.
 */
export async function agreedFinalizedBlock(clients: readonly [PublicClient, PublicClient]): Promise<bigint> {
  if (clients[0] === clients[1]) return (await clients[0].getBlock({ blockTag: 'finalized' })).number;
  const [first, second] = await Promise.all(clients.map(async (c) => (await c.getBlock({ blockTag: 'finalized' })).number));
  const at = first < second ? first : second;
  await readOnBoth(clients, `finalized block ${at}`, async (c) => (await c.getBlock({ blockNumber: at })).hash);
  return at;
}
