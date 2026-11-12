import { bytesToHex, sha256 } from 'viem';
import { attestationsOf, MAX_PROOF_BYTES, mergeAt, OtsError, parseTimestamp, serializeProof, type Proof } from './format';
import { readCapped } from './read-capped';

/**
 * Talking to OpenTimestamps calendars (#66). A calendar takes a digest,
 * answers with a pending timestamp at once, aggregates what it was sent into
 * a Bitcoin transaction, and later answers with the path from the digest to
 * that block. Only the calendars listed here are ever asked anything: a
 * pending attestation naming another URL is kept in the proof and never
 * fetched, so a calendar's answer cannot point this server at an address.
 *
 * The digest is never sent as it is. As the reference client does, a random
 * nonce is appended and the result hashed, and that is what the calendars
 * see, so they cannot tell which manifest they hold.
 */

/** The reference client's default calendars, run by three operators. */
export const OTS_CALENDARS = [
  'https://alice.btc.calendar.opentimestamps.org',
  'https://bob.btc.calendar.opentimestamps.org',
  'https://finney.calendar.eternitywall.com',
  'https://btc.calendar.catallaxy.com',
] as const;
/** A proof is kept only when at least this many calendars took the digest. */
export const MIN_CALENDARS = 2;

const ACCEPT = 'application/vnd.opentimestamps.v1';
/** The reference client's cap on a calendar's answer. */
const MAX_RESPONSE_BYTES = 10_000;
const TIMEOUT_MS = 15_000;
const NONCE_BYTES = 16;

export interface CalendarDeps {
  calendars?: readonly string[];
  fetch?: typeof fetch;
}

/** A name for why a calendar did not help, never its body. */
export type CalendarFailure =
  | 'UNREACHABLE'
  | 'HTTP_ERROR'
  | 'TOO_LARGE'
  | 'BAD_ANSWER'
  /** Merged, the answer would make the proof larger than a proof is read (#147). */
  | 'PROOF_TOO_LARGE';

async function bodyOf(res: Response): Promise<Uint8Array> {
  const body = await readCapped(res, MAX_RESPONSE_BYTES);
  if (!body) throw new OtsError('TOO_LARGE', 'the calendar answered too much');
  return body;
}

const failureOf = (error: unknown): CalendarFailure => (error instanceof OtsError ? (error.code === 'TOO_LARGE' ? 'TOO_LARGE' : 'BAD_ANSWER') : 'UNREACHABLE');

export interface Submission {
  proof: Proof;
  accepted: string[];
  refused: { calendar: string; reason: CalendarFailure }[];
}

/**
 * Sends a digest, behind a nonce, to every calendar; the proof holds every
 * answer. The caller keeps it only when `accepted` has MIN_CALENDARS or more.
 */
export async function submitDigest(digest: Uint8Array, deps: CalendarDeps = {}, nonce: Uint8Array = crypto.getRandomValues(new Uint8Array(NONCE_BYTES))): Promise<Submission> {
  if (digest.length !== 32) throw new OtsError('UNSUPPORTED_OP', 'only a SHA-256 digest is timestamped');
  const calendars = deps.calendars ?? OTS_CALENDARS;
  const fetchImpl = deps.fetch ?? fetch;
  const salted = new Uint8Array(digest.length + nonce.length);
  salted.set(digest);
  salted.set(nonce, digest.length);
  const commitment = sha256(salted, 'bytes');
  const proof: Proof = {
    digest,
    timestamp: { attestations: [], ops: [{ op: { op: 'append', arg: nonce }, next: { attestations: [], ops: [{ op: { op: 'sha256' }, next: { attestations: [], ops: [] } }] } }] },
  };
  const answers = await Promise.all(
    calendars.map(async (calendar) => {
      try {
        const res = await fetchImpl(`${calendar}/digest`, {
          method: 'POST',
          body: new Uint8Array(commitment),
          headers: { Accept: ACCEPT, 'Content-Type': 'application/x-www-form-urlencoded' },
          signal: AbortSignal.timeout(TIMEOUT_MS),
          redirect: 'error',
          credentials: 'omit',
        });
        if (!res.ok) return { ok: false as const, calendar, reason: 'HTTP_ERROR' as const };
        return { ok: true as const, calendar, stamp: parseTimestamp(await bodyOf(res), commitment) };
      } catch (error) {
        return { ok: false as const, calendar, reason: failureOf(error) };
      }
    }),
  );
  const accepted: string[] = [];
  const refused: Submission['refused'] = [];
  for (const answer of answers) {
    if (answer.ok) {
      mergeAt(proof, commitment, answer.stamp);
      accepted.push(answer.calendar);
    } else {
      refused.push({ calendar: answer.calendar, reason: answer.reason });
    }
  }
  return { proof, accepted, refused };
}

export interface Upgrade {
  /** Whether a calendar added anything to the proof. */
  changed: boolean;
  /** Calendars that answered "not yet". */
  pending: string[];
  failed: { calendar: string; reason: CalendarFailure }[];
}

/**
 * Asks each listed calendar named by a pending attestation in the proof
 * whether it has the path to Bitcoin yet, and merges what it has. The proof
 * is changed in place, one calendar's answer at a time: an answer that would
 * take the proof past MAX_PROOF_BYTES is not merged (#147), since a proof
 * that large could never be read again, here or by a verifier. Whether what
 * a calendar answered holds is the Bitcoin check's question, not this one's.
 */
export async function upgradeProof(proof: Proof, deps: CalendarDeps = {}): Promise<Upgrade> {
  const calendars = new Set<string>(deps.calendars ?? OTS_CALENDARS);
  const fetchImpl = deps.fetch ?? fetch;
  const result: Upgrade = { changed: false, pending: [], failed: [] };
  const asked = new Set<string>();
  for (const { attestation, message } of attestationsOf(proof)) {
    if (attestation.kind !== 'pending' || !calendars.has(attestation.uri)) continue;
    const key = `${attestation.uri} ${bytesToHex(message)}`;
    if (asked.has(key)) continue;
    asked.add(key);
    try {
      const res = await fetchImpl(`${attestation.uri}/timestamp/${bytesToHex(message).slice(2)}`, {
        headers: { Accept: ACCEPT },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: 'error',
        credentials: 'omit',
      });
      if (res.status === 404) {
        result.pending.push(attestation.uri);
        continue;
      }
      if (!res.ok) {
        result.failed.push({ calendar: attestation.uri, reason: 'HTTP_ERROR' });
        continue;
      }
      const body = await bodyOf(res);
      // Merged into a copy first: a merge that would be too large leaves the proof as it was.
      const trial: Proof = { digest: proof.digest, timestamp: structuredClone(proof.timestamp) };
      if (!mergeAt(trial, message, parseTimestamp(body, message))) continue;
      if (serializeProof(trial).length > MAX_PROOF_BYTES) {
        result.failed.push({ calendar: attestation.uri, reason: 'PROOF_TOO_LARGE' });
        continue;
      }
      proof.timestamp = trial.timestamp;
      result.changed = true;
    } catch (error) {
      result.failed.push({ calendar: attestation.uri, reason: failureOf(error) });
    }
  }
  return result;
}
