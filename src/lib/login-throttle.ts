/**
 * Slows online password guessing (#58). After 5 failed sign-ins for one
 * email, or 10 from one client address, further attempts are refused for 15
 * minutes; and one address may try at most 10 times a minute, right or wrong.
 * A refused attempt looks exactly like a wrong password, so the throttle tells
 * an attacker nothing about which emails exist.
 *
 * The per-email limit does not depend on the address, because the address
 * comes from X-Forwarded-For, which a client can set at will unless a trusted
 * proxy adds to it (TRUST_PROXY_HEADERS=1; clientAddressOf). Without that, only the
 * per-email limit applies. The price is that a stranger can lock an account
 * for 15 minutes; for a handful of staff accounts that is the better trade.
 *
 * An attempt counts as a failure from the moment it starts (#150), before
 * any password is checked, and only one attempt per email is checked at a
 * time: otherwise attempts sent together all pass the check before the first
 * failure is recorded. Every sign-in also costs a bcrypt compare, so all of
 * them together are held to a few at a time and a number a minute, refused
 * before the compare; that bounds the CPU sign-in can take whatever the
 * address.
 *
 * In memory, per server process: enough for the single-instance prototype.
 */
import { createLimiter } from './rate-limit';

const WINDOW_MS = 15 * 60 * 1000;
const PER_ACCOUNT = 5;
const PER_ADDRESS = 10;
const ATTEMPTS_PER_ADDRESS_PER_MINUTE = 10;
/** All sign-ins together: each one runs a cost-12 bcrypt compare in this process. */
export const SIGN_INS_PER_MINUTE = 120;
export const MAX_CONCURRENT_SIGN_INS = 4;
/** Expired failures are swept once this many keys are tracked. */
const SWEEP_AT = 10_000;

let attempts = createLimiter({ limit: ATTEMPTS_PER_ADDRESS_PER_MINUTE, windowMs: 60_000 });
let total = createLimiter({ limit: SIGN_INS_PER_MINUTE, windowMs: 60_000 });

const failures = new Map<string, number[]>();
/** Lower-cased emails with an attempt being checked. */
const inFlight = new Set<string>();
/** Attempts holding a slot: every one but BUSY, until it ends. */
let running = 0;
let sweepAt = SWEEP_AT;

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
  // Random emails each add a key; drop the expired ones now and then, and rarely, however many are live.
  if (failures.size > sweepAt) {
    for (const key of failures.keys()) recent(key, now);
    sweepAt = Math.max(SWEEP_AT, 2 * failures.size);
  }
}

export function recordSuccess(email: string): void {
  failures.delete(keysFor(email, null)[0]);
}

/** Removes one failure recorded at `at`, as a released attempt's reservation. */
function forget(key: string, at: number): void {
  const times = failures.get(key);
  const i = times?.indexOf(at) ?? -1;
  if (!times || i < 0) return;
  times.splice(i, 1);
  if (times.length === 0) failures.delete(key);
}

/**
 * Why an attempt is refused unchecked. ADDRESS_LIMIT: the address's attempts
 * this minute, checked first, so one address cannot spend the overall budget
 * (only behind a trusted proxy, which names the address). BUSY: too many
 * sign-ins at once or this minute. The caller spends no compare on either.
 * The others are answered like a wrong password: IN_FLIGHT, an attempt for
 * this email is being checked; LOCKED, too many failures.
 */
export type SignInRefusal = 'BUSY' | 'ADDRESS_LIMIT' | 'IN_FLIGHT' | 'LOCKED';
/**
 * FAILED keeps the failure the attempt was counted as; SUCCEEDED clears the
 * email's failures; RELEASED takes the attempt back (the password was right
 * and the code is still to come). Only the first call counts.
 */
export type SignInOutcome = 'FAILED' | 'SUCCEEDED' | 'RELEASED';
export type SignInAttempt = { ok: true; end(outcome: SignInOutcome): void } | { ok: false; reason: SignInRefusal; end(outcome?: SignInOutcome): void };

/**
 * Starts a sign-in attempt, synchronously, before anything is awaited: it is
 * counted as a failure and marked in flight for its email at once. Every
 * attempt must be ended, a refused one included (it holds a slot while the
 * caller runs its dummy compare).
 */
export function beginSignIn(email: string, address: string | null, now = Date.now()): SignInAttempt {
  if (!takeSignInAttempt(address, now)) return { ok: false, reason: 'ADDRESS_LIMIT', end: () => {} };
  if (running >= MAX_CONCURRENT_SIGN_INS || !total.take('*', now).ok) return { ok: false, reason: 'BUSY', end: () => {} };
  running++;
  let ended = false;
  const finish = (settle: () => void) => {
    if (ended) return;
    ended = true;
    running--;
    settle();
  };
  const refuse = (reason: SignInRefusal): SignInAttempt => ({ ok: false, reason, end: () => finish(() => {}) });
  const account = email.toLowerCase();
  if (inFlight.has(account)) return refuse('IN_FLIGHT');
  if (isThrottled(email, address, now)) return refuse('LOCKED');
  inFlight.add(account);
  recordFailure(email, address, now);
  return {
    ok: true,
    end: (outcome) =>
      finish(() => {
        inFlight.delete(account);
        if (outcome === 'FAILED') return;
        const [accountKey, addressKey] = keysFor(email, address);
        if (outcome === 'SUCCEEDED') recordSuccess(email);
        else forget(accountKey, now);
        if (addressKey) forget(addressKey, now);
      }),
  };
}

/** Test seam: how many emails and addresses have failures tracked. */
export function trackedFailureKeys(): number {
  return failures.size;
}

/** Test seam: forget every recorded failure. */
export function resetThrottle(): void {
  failures.clear();
  inFlight.clear();
  running = 0;
  sweepAt = SWEEP_AT;
  attempts = createLimiter({ limit: ATTEMPTS_PER_ADDRESS_PER_MINUTE, windowMs: 60_000 });
  total = createLimiter({ limit: SIGN_INS_PER_MINUTE, windowMs: 60_000 });
}
