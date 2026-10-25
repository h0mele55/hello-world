/**
 * Slows online password guessing (#58). After 5 failed sign-ins for one
 * email, or 10 from one client address, further attempts are refused for 15
 * minutes; and one address may try at most 10 times a minute, right or wrong.
 * A refused attempt looks exactly like a wrong password, so the throttle tells
 * an attacker nothing about which emails exist.
 *
 * The per-email limit does not depend on the address, because the address
 * comes from X-Forwarded-For, which a client can set at will unless a trusted
 * proxy overwrites it (TRUST_PROXY_HEADERS=1). Without that, only the
 * per-email limit applies. The price is that a stranger can lock an account
 * for 15 minutes; for a handful of staff accounts that is the better trade.
 *
 * In memory, per server process: enough for the single-instance prototype.
 */
import { createLimiter } from './rate-limit';

const WINDOW_MS = 15 * 60 * 1000;
const PER_ACCOUNT = 5;
const PER_ADDRESS = 10;
const ATTEMPTS_PER_ADDRESS_PER_MINUTE = 10;

let attempts = createLimiter({ limit: ATTEMPTS_PER_ADDRESS_PER_MINUTE, windowMs: 60_000 });

const failures = new Map<string, number[]>();

function recent(key: string, now: number): number[] {
  const kept = (failures.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  if (kept.length === 0) failures.delete(key);
  else failures.set(key, kept);
  return kept;
}

function keysFor(email: string, address: string | null): string[] {
  const keys = [`a|${email.toLowerCase()}`];
  if (address) keys.push(`i|${address}`);
  return keys;
}

export function isThrottled(email: string, address: string | null, now = Date.now()): boolean {
  const [account, byAddress] = keysFor(email, address);
  return recent(account, now).length >= PER_ACCOUNT || (byAddress !== undefined && recent(byAddress, now).length >= PER_ADDRESS);
}

/** Counts a sign-in attempt from an address; false once it has made 10 in the last minute. */
export function takeSignInAttempt(address: string | null, now = Date.now()): boolean {
  return address === null || attempts.take(address, now).ok;
}

export function recordFailure(email: string, address: string | null, now = Date.now()): void {
  for (const key of keysFor(email, address)) failures.set(key, [...recent(key, now), now]);
}

export function recordSuccess(email: string): void {
  failures.delete(keysFor(email, null)[0]);
}

/** Test seam: forget every recorded failure. */
export function resetThrottle(): void {
  failures.clear();
  attempts = createLimiter({ limit: ATTEMPTS_PER_ADDRESS_PER_MINUTE, windowMs: 60_000 });
}
