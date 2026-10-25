import { bytesToHex, type Hex } from 'viem';
import { BitcoinError, bitcoinTimeOf, esploraSource, type HeaderSource } from '../ots/bitcoin';
import { BITCOIN_EXPLORERS, EXPLORER_ORIGINS } from '../ots/explorers';
import { attestationsOf, OtsError, parseProof } from '../ots/format';

/**
 * The second, independent timestamp of a matched report (#66): the issuer's
 * OpenTimestamps proof of its manifest hash, checked against Bitcoin in the
 * verifier itself. It never changes the verdict, which rests on the registry
 * alone; it only adds when the manifest existed by, on another chain.
 *
 * The proof is asked of the issuer's server by the manifest hash, which is
 * public on chain; the file never leaves the visitor (rule 5). With the
 * server down, or no proof yet, the verdict stands and this says so.
 */

export type BitcoinTimestamp =
  /** The proof reaches a Bitcoin block, checked against two explorers. */
  | { status: 'CONFIRMED'; height: number; blockHash: Hex; time: number }
  /** The issuer has a proof, but Bitcoin has not confirmed it yet. */
  | { status: 'PENDING' }
  /** The issuer has no proof for this manifest. */
  | { status: 'NONE' }
  /** It could not be checked now: the issuer or the explorers did not answer, or the explorers disagree. */
  | { status: 'UNAVAILABLE'; reason: 'ISSUER_UNREACHABLE' | 'EXPLORERS_UNREADABLE' | 'EXPLORERS_DISAGREE' | 'BAD_HEADER' }
  /** The proof is wrong: for another manifest, unreadable, or leading to something the block does not hold. */
  | { status: 'INVALID'; reason: 'NOT_THIS_MANIFEST' | 'PROOF_UNREADABLE' | 'NOT_IN_BLOCK' };

/** What the verifier needs: where to ask for a proof, and the two explorers. */
export interface TimestampSources {
  /** The proof for a manifest hash, null when the issuer has none; throws when the issuer cannot be reached. */
  fetchProof: (manifestHash: Hex) => Promise<Uint8Array | null>;
  explorers: readonly [HeaderSource, HeaderSource];
}

/** The largest proof the verifier reads; the format's own limit. */
const MAX_PROOF_BYTES = 1 << 16;

/** Asks the issuer's public proof route (`/ots/<manifestHash>`) at `appUrl`. */
export function issuerProofFetcher(appUrl: string, fetchImpl: typeof fetch = fetch): TimestampSources['fetchProof'] {
  const base = appUrl.replace(/\/+$/, '');
  return async (manifestHash) => {
    const res = await fetchImpl(`${base}/ots/${manifestHash}`, { signal: AbortSignal.timeout(15_000), credentials: 'omit', redirect: 'error' });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`the issuer answered ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > MAX_PROOF_BYTES) throw new OtsError('TOO_LARGE', 'the proof is too large');
    return bytes;
  };
}

/** The two public explorers, for a verifier that has no others. */
export const defaultExplorers = (fetchImpl: typeof fetch = fetch): TimestampSources['explorers'] => [esploraSource(BITCOIN_EXPLORERS[0], fetchImpl), esploraSource(BITCOIN_EXPLORERS[1], fetchImpl)];

export { EXPLORER_ORIGINS };

export async function bitcoinTimestampFor(manifestHash: Hex, sources: TimestampSources): Promise<BitcoinTimestamp> {
  let bytes: Uint8Array | null;
  try {
    bytes = await sources.fetchProof(manifestHash);
  } catch (error) {
    if (error instanceof OtsError) return { status: 'INVALID', reason: 'PROOF_UNREADABLE' };
    return { status: 'UNAVAILABLE', reason: 'ISSUER_UNREACHABLE' };
  }
  if (!bytes) return { status: 'NONE' };

  let proof;
  try {
    proof = parseProof(bytes);
  } catch (error) {
    if (error instanceof OtsError) return { status: 'INVALID', reason: 'PROOF_UNREADABLE' };
    throw error;
  }
  if (bytesToHex(proof.digest) !== manifestHash.toLowerCase()) return { status: 'INVALID', reason: 'NOT_THIS_MANIFEST' };
  if (!attestationsOf(proof).some((a) => a.attestation.kind === 'bitcoin')) return { status: 'PENDING' };

  try {
    const time = await bitcoinTimeOf(proof, sources.explorers);
    return time ? { status: 'CONFIRMED', ...time } : { status: 'PENDING' };
  } catch (error) {
    if (!(error instanceof BitcoinError)) throw error;
    if (error.code === 'NOT_IN_BLOCK') return { status: 'INVALID', reason: 'NOT_IN_BLOCK' };
    return { status: 'UNAVAILABLE', reason: error.code === 'UNREADABLE' ? 'EXPLORERS_UNREADABLE' : error.code === 'DISAGREE' ? 'EXPLORERS_DISAGREE' : 'BAD_HEADER' };
  }
}
