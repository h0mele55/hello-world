/**
 * Slows online password guessing: after 5 failed sign-ins for one email, or
 * 20 from one client address, further attempts are refused for 15 minutes. A
 * refused attempt looks exactly like a wrong password, so the throttle tells
 * an attacker nothing about which emails exist.
 *
 * The per-email limit does not depend on the address, because the address
 * comes from X-Forwarded-For, which a client can set at will unless a trusted
 * proxy overwrites it (TRUST_PROXY_HEADERS=1). Without that, only the
 * per-email limit applies. The price is that a stranger can lock an account
 * for 15 minutes; for two staff accounts that is the better trade.
 *
 * In memory, per server process: enough for the single-instance prototype.
 */
const WINDOW_MS = 15 * 60 * 1000;
const PER_ACCOUNT = 5;
const PER_ADDRESS = 20;

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

export function recordFailure(email: string, address: string | null, now = Date.now()): void {
  for (const key of keysFor(email, address)) failures.set(key, [...recent(key, now), now]);
}

export function recordSuccess(email: string): void {
  failures.delete(keysFor(email, null)[0]);
}

/** Test seam: forget every recorded failure. */
export function resetThrottle(): void {
  failures.clear();
}
