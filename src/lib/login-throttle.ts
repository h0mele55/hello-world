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
 * Attempts for one email are checked one at a time, in the order they came
 * (#150): each waits for the one before it to end, then is held to the
 * lockout that one left, and counts as a failure from that moment until it
 * succeeds. Otherwise attempts sent together all pass the check before the
 * first failure is recorded. A second attempt is not refused for arriving
 * early (a double click, two tabs, two test workers); only past two waiting
 * is one refused unchecked. Every sign-in also costs a bcrypt compare, so all of
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
/** Attempts that may wait behind the one being checked for an email; more are refused unchecked (IN_FLIGHT). */
export const MAX_WAITING_PER_EMAIL = 2;
/** Expired failures are swept once this many keys are tracked. */
const SWEEP_AT = 10_000;

let attempts = createLimiter({ limit: ATTEMPTS_PER_ADDRESS_PER_MINUTE, windowMs: 60_000 });
let total = createLimiter({ limit: SIGN_INS_PER_MINUTE, windowMs: 60_000 });

const failures = new Map<string, number[]>();
/** Per lower-cased email: the end of the last attempt in line, and how many hold or wait for the turn. */
const turns = new Map<string, { tail: Promise<void>; pending: number }>();
/** Attempts holding a slot (being checked, or refused and running the dummy compare), until they end. */
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
 * The others are answered like a wrong password: IN_FLIGHT, more attempts for
 * this email are already waiting than may; LOCKED, too many failures.
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
 * Starts a sign-in attempt. Call it before anything else is awaited: the
 * limits on the address and on all sign-ins are taken at once, and the
 * attempt takes its place in its email's line. It resolves when its turn
 * comes, counted as a failure from then on. Every attempt must be ended, a
 * refused one included (it holds a slot while the caller runs its dummy
 * compare, and its email's turn until then).
 */
export async function beginSignIn(email: string, address: string | null, now?: number): Promise<SignInAttempt> {
  const startedAt = now ?? Date.now();
  const unchecked = (reason: SignInRefusal): SignInAttempt => ({ ok: false, reason, end: () => {} });
  if (!takeSignInAttempt(address, startedAt)) return unchecked('ADDRESS_LIMIT');
  if (!total.take('*', startedAt).ok) return unchecked('BUSY');
  /** A slot for a refusal answered like a wrong password, or BUSY when none is free. */
  const refuseWithSlot = (reason: SignInRefusal, leave: () => void): SignInAttempt => {
    if (running >= MAX_CONCURRENT_SIGN_INS) {
      leave();
      return unchecked('BUSY');
    }
    running++;
    let ended = false;
    return {
      ok: false,
      reason,
      end: () => {
        if (ended) return;
        ended = true;
        running--;
        leave();
      },
    };
  };
  const account = email.toLowerCase();
  const turn = turns.get(account) ?? { tail: Promise.resolve(), pending: 0 };
  if (turn.pending > MAX_WAITING_PER_EMAIL) return refuseWithSlot('IN_FLIGHT', () => {});
  turn.pending++;
  turns.set(account, turn);
  const previous = turn.tail;
  let release!: () => void;
  turn.tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  const leave = () => {
    release();
    if (--turn.pending === 0) turns.delete(account);
  };
  await previous;
  const at = now ?? Date.now();
  if (isThrottled(email, address, at)) return refuseWithSlot('LOCKED', leave);
  if (running >= MAX_CONCURRENT_SIGN_INS) {
    leave();
    return unchecked('BUSY');
  }
  running++;
  recordFailure(email, address, at);
  let ended = false;
  return {
    ok: true,
    end: (outcome) => {
      if (ended) return;
      ended = true;
      running--;
      leave();
      if (outcome === 'FAILED') return;
      const [accountKey, addressKey] = keysFor(email, address);
      if (outcome === 'SUCCEEDED') recordSuccess(email);
      else forget(accountKey, at);
      if (addressKey) forget(addressKey, at);
    },
  };
}

/** Test seam: how many emails and addresses have failures tracked. */
export function trackedFailureKeys(): number {
  return failures.size;
}

/** Test seam: forget every recorded failure. */
export function resetThrottle(): void {
  failures.clear();
  turns.clear();
  running = 0;
  sweepAt = SWEEP_AT;
  attempts = createLimiter({ limit: ATTEMPTS_PER_ADDRESS_PER_MINUTE, windowMs: 60_000 });
  total = createLimiter({ limit: SIGN_INS_PER_MINUTE, windowMs: 60_000 });
}
