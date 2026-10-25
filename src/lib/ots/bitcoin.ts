import { bytesToHex, sha256, type Hex } from 'viem';
import { attestationsOf, type Proof } from './format';

/**
 * Checking a proof's Bitcoin attestation (#66). The message a proof's
 * operations lead to must be the Merkle root of the block at the attested
 * height. The block's header is read from two block explorers run by
 * different operators: both must return the same 80 bytes, whose double
 * SHA-256 must be the hash each gave for that height and must meet the
 * header's own proof-of-work target, which must itself be at least as hard as
 * Bitcoin's in 2015. Any doubt is a named reason, never a pass (rule 7).
 *
 * No Node imports: the browser verifier shares it.
 */

export class BitcoinError extends Error {
  readonly code: BitcoinErrorCode;
  constructor(code: BitcoinErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'BitcoinError';
  }
}

/**
 * UNREADABLE and DISAGREE are about the explorers, and may pass; BAD_HEADER
 * is two explorers agreeing on a header that is not a real block's, which a
 * person looks at; NOT_IN_BLOCK is the proof itself being wrong.
 */
export type BitcoinErrorCode = 'UNREADABLE' | 'DISAGREE' | 'BAD_HEADER' | 'NOT_IN_BLOCK';

export interface BlockHeader {
  /** The block's hash as explorers show it. */
  hash: Hex;
  /** The Merkle root in the header's own byte order, the order a proof's message is in. */
  merkleRoot: Uint8Array;
  /** The miner's clock, in Unix seconds: within about two hours of the truth. */
  time: number;
  bits: number;
}

const HEADER_BYTES = 80;
/** The target at difficulty 1. */
const POW_LIMIT = 0xffffn << 208n;
/**
 * A header must be at least this hard: every block since early 2015 is, and so
 * is every block a calendar has used, so an explorer cannot pass off a header
 * mined on a laptop.
 */
export const MIN_DIFFICULTY = 10_000_000_000n;

const sha256d = (bytes: Uint8Array) => sha256(sha256(bytes, 'bytes'), 'bytes');
const reversedHex = (bytes: Uint8Array): Hex => bytesToHex(bytes.slice().reverse());
const u32 = (bytes: Uint8Array, at: number) => (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;

export function readHeader(bytes: Uint8Array): BlockHeader {
  if (bytes.length !== HEADER_BYTES) throw new BitcoinError('BAD_HEADER', `a block header is ${HEADER_BYTES} bytes, not ${bytes.length}`);
  return { hash: reversedHex(sha256d(bytes)), merkleRoot: bytes.slice(36, 68), time: u32(bytes, 68), bits: u32(bytes, 72) };
}

/** The target a header's `bits` encode, or null for an encoding Bitcoin refuses. */
export function targetOf(bits: number): bigint | null {
  const exponent = bits >>> 24;
  const mantissa = BigInt(bits & 0x007fffff);
  if (bits & 0x00800000 || mantissa === 0n) return null;
  return exponent <= 3 ? mantissa >> BigInt(8 * (3 - exponent)) : mantissa << BigInt(8 * (exponent - 3));
}

/** The header's hash meets its own target, and that target is at least MIN_DIFFICULTY. */
export function hasProofOfWork(header: BlockHeader): boolean {
  const target = targetOf(header.bits);
  return target !== null && target <= POW_LIMIT / MIN_DIFFICULTY && BigInt(header.hash) <= target;
}

/** Where block headers come from: a block explorer, by height. */
export interface HeaderSource {
  /** Its origin, which names it in a refusal. */
  readonly origin: string;
  header(height: number): Promise<Uint8Array>;
}

const MAX_TEXT = 256;
const TIMEOUT_MS = 15_000;

/**
 * An Esplora explorer (blockstream.info/api, mempool.space/api): the hash at a
 * height, then the header by that hash, which must hash to it.
 */
export function esploraSource(baseUrl: string, fetchImpl: typeof fetch = fetch): HeaderSource {
  const base = baseUrl.replace(/\/+$/, '');
  const origin = new URL(base).origin;
  const text = async (path: string, shape: RegExp) => {
    const res = await fetchImpl(`${base}${path}`, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error', credentials: 'omit' });
    if (!res.ok) throw new BitcoinError('UNREADABLE', `${origin} answered ${res.status}`);
    const body = (await res.text()).trim();
    if (body.length > MAX_TEXT || !shape.test(body)) throw new BitcoinError('UNREADABLE', `${origin} answered something that is not a block hash or header`);
    return body;
  };
  return {
    origin,
    async header(height) {
      const hash = await text(`/block-height/${height}`, /^[0-9a-f]{64}$/);
      const hex = await text(`/block/${hash}/header`, /^[0-9a-f]{160}$/);
      const bytes = Uint8Array.from(hex.match(/../g)!.map((b) => parseInt(b, 16)));
      if (readHeader(bytes).hash !== `0x${hash}`) throw new BitcoinError('UNREADABLE', `${origin} gave a header that is not the block it named`);
      return bytes;
    },
  };
}

export { BITCOIN_EXPLORERS } from './explorers';

/** A cache of agreed headers by height, for one pass: calendars put many proofs in one block. */
export type HeaderCache = Map<number, Promise<BlockHeader>>;

/** The header at `height` that both sources give, checked. */
export function agreedHeader(sources: readonly [HeaderSource, HeaderSource], height: number, cache?: HeaderCache): Promise<BlockHeader> {
  const cached = cache?.get(height);
  if (cached) return cached;
  const read = (async () => {
    if (!Number.isSafeInteger(height) || height < 0) throw new BitcoinError('BAD_HEADER', `${height} is not a block height`);
    if (sources[0].origin === sources[1].origin) throw new BitcoinError('DISAGREE', 'the two explorers are one');
    const [a, b] = await Promise.all(
      sources.map((source) =>
        source.header(height).catch((error: unknown) => {
          throw error instanceof BitcoinError ? error : new BitcoinError('UNREADABLE', `${source.origin} could not be read`);
        }),
      ),
    );
    if (a.length !== b.length || a.some((byte, i) => byte !== b[i])) throw new BitcoinError('DISAGREE', `the explorers give different blocks at height ${height}`);
    const header = readHeader(a);
    if (!hasProofOfWork(header)) throw new BitcoinError('BAD_HEADER', `the block at height ${height} does not carry the work Bitcoin's do`);
    return header;
  })();
  if (cache) {
    cache.set(height, read);
    // A failure is not remembered: the next asker tries again.
    read.catch(() => cache.delete(height));
  }
  return read;
}

export interface BitcoinTime {
  height: number;
  blockHash: Hex;
  /** The block's time, Unix seconds. */
  time: number;
}

/** Whether `message` is the Merkle root of the block at `height`. */
export async function checkBitcoinAttestation(message: Uint8Array, height: number, sources: readonly [HeaderSource, HeaderSource], cache?: HeaderCache): Promise<BitcoinTime> {
  const header = await agreedHeader(sources, height, cache);
  if (message.length !== 32 || message.some((byte, i) => byte !== header.merkleRoot[i])) {
    throw new BitcoinError('NOT_IN_BLOCK', `the proof does not lead to the Merkle root of block ${height}`);
  }
  return { height, blockHash: header.hash, time: header.time };
}

/**
 * The earliest Bitcoin time a proof shows, every Bitcoin attestation in it
 * checked: one that does not hold fails the proof, whatever the others say.
 * Null when it has none yet.
 */
export async function bitcoinTimeOf(proof: Proof, sources: readonly [HeaderSource, HeaderSource], cache?: HeaderCache): Promise<BitcoinTime | null> {
  let earliest: BitcoinTime | null = null;
  for (const { attestation, message } of attestationsOf(proof)) {
    if (attestation.kind !== 'bitcoin') continue;
    const time = await checkBitcoinAttestation(message, attestation.height, sources, cache);
    if (!earliest || time.height < earliest.height) earliest = time;
  }
  return earliest;
}
