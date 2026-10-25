import { bytesToHex, keccak256, ripemd160, sha256, type Hex } from 'viem';

/**
 * OpenTimestamps proofs (#66): a second, independent timestamp of each
 * manifest hash, on Bitcoin. This reads and writes the `.ots` format (a
 * detached timestamp file) and walks its operations from the digest to each
 * attestation. No Node imports and no `Buffer`: the browser verifier shares it.
 *
 * The format: the magic, a version, the file hash operation and the digest,
 * then a tree of operations (append, prepend, hashes) whose leaves are
 * attestations: "pending at this calendar", or "this message is the Merkle
 * root of Bitcoin block N". Anything the format allows that this reader does
 * not know is refused by name (rule 7), never skipped.
 */

export const OTS_MAGIC = new Uint8Array([
  0x00, 0x4f, 0x70, 0x65, 0x6e, 0x54, 0x69, 0x6d, 0x65, 0x73, 0x74, 0x61, 0x6d, 0x70, 0x73, 0x00, 0x00, 0x50, 0x72, 0x6f, 0x6f, 0x66, 0x00, 0xbf, 0x89, 0xe2,
  0xe8, 0x84, 0xe8, 0x92, 0x94,
]);
const VERSION = 1;
/** The format's own limits: a message or an operand longer than this is refused. */
export const MAX_MESSAGE_LENGTH = 4096;
const MAX_DEPTH = 256;
const MAX_PROOF_BYTES = 1 << 16;
const MAX_URI_LENGTH = 1000;

const BITCOIN_TAG = '0x0588960d73d71901';
const PENDING_TAG = '0x83dfe30d2ef90c8e';

export type UnaryOp = 'sha256' | 'ripemd160' | 'keccak256' | 'reverse' | 'hexlify';
export type Op = { op: UnaryOp } | { op: 'append' | 'prepend'; arg: Uint8Array };

export type Attestation =
  | { kind: 'bitcoin'; height: number }
  | { kind: 'pending'; uri: string }
  /** Another chain's, or a later version's: kept, never trusted. */
  | { kind: 'unknown'; tag: Hex; payload: Uint8Array };

export interface Timestamp {
  attestations: Attestation[];
  ops: { op: Op; next: Timestamp }[];
}

export interface Proof {
  /** The digest timestamped: here, always a SHA-256. */
  digest: Uint8Array;
  timestamp: Timestamp;
}

export class OtsError extends Error {
  readonly code: string;
  constructor(code: 'BAD_MAGIC' | 'BAD_VERSION' | 'TRUNCATED' | 'TRAILING_BYTES' | 'UNSUPPORTED_OP' | 'TOO_DEEP' | 'TOO_LARGE' | 'BAD_ATTESTATION' | 'EMPTY', message: string) {
    super(message);
    this.code = code;
    this.name = 'OtsError';
  }
}

const UNARY_TAGS: Record<number, UnaryOp> = { 0x08: 'sha256', 0x03: 'ripemd160', 0x67: 'keccak256', 0xf2: 'reverse', 0xf3: 'hexlify' };
const TAG_OF: Record<Op['op'], number> = { sha256: 0x08, ripemd160: 0x03, keccak256: 0x67, reverse: 0xf2, hexlify: 0xf3, append: 0xf0, prepend: 0xf1 };

// ── Operations ──

export function applyOp(op: Op, message: Uint8Array): Uint8Array {
  let out: Uint8Array;
  switch (op.op) {
    case 'sha256':
      out = sha256(message, 'bytes');
      break;
    case 'ripemd160':
      out = ripemd160(message, 'bytes');
      break;
    case 'keccak256':
      out = keccak256(message, 'bytes');
      break;
    case 'reverse':
      out = message.slice().reverse();
      break;
    case 'hexlify':
      out = new TextEncoder().encode(bytesToHex(message).slice(2));
      break;
    case 'append':
      out = concat(message, op.arg);
      break;
    case 'prepend':
      out = concat(op.arg, message);
      break;
  }
  if (out.length > MAX_MESSAGE_LENGTH) throw new OtsError('TOO_LARGE', `an operation's result is longer than ${MAX_MESSAGE_LENGTH} bytes`);
  return out;
}

const concat = (a: Uint8Array, b: Uint8Array) => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
};

// ── Reading ──

class Reader {
  private at = 0;
  constructor(private readonly bytes: Uint8Array) {}
  byte(): number {
    if (this.at >= this.bytes.length) throw new OtsError('TRUNCATED', 'the proof ends early');
    return this.bytes[this.at++];
  }
  take(n: number): Uint8Array {
    if (this.at + n > this.bytes.length) throw new OtsError('TRUNCATED', 'the proof ends early');
    const out = this.bytes.slice(this.at, this.at + n);
    this.at += n;
    return out;
  }
  varuint(): number {
    let value = 0;
    for (let shift = 0; ; shift += 7) {
      if (shift > 49) throw new OtsError('TOO_LARGE', 'a number in the proof is too large');
      const b = this.byte();
      value += (b & 0x7f) * 2 ** shift;
      if (!(b & 0x80)) return value;
    }
  }
  varbytes(max: number): Uint8Array {
    const length = this.varuint();
    if (length > max) throw new OtsError('TOO_LARGE', `a field of ${length} bytes is over the limit of ${max}`);
    return this.take(length);
  }
  done(): boolean {
    return this.at === this.bytes.length;
  }
}

function readAttestation(r: Reader): Attestation {
  const tag = bytesToHex(r.take(8));
  const payload = r.varbytes(8192);
  const inner = new Reader(payload);
  if (tag === BITCOIN_TAG) {
    const height = inner.varuint();
    if (!inner.done()) throw new OtsError('BAD_ATTESTATION', 'a Bitcoin attestation carries more than its height');
    return { kind: 'bitcoin', height };
  }
  if (tag === PENDING_TAG) {
    const uri = new TextDecoder('utf-8', { fatal: true }).decode(inner.varbytes(MAX_URI_LENGTH));
    if (!inner.done() || !/^https:\/\/[A-Za-z0-9.-]+(:\d+)?(\/[A-Za-z0-9._~/-]*)?$/.test(uri)) throw new OtsError('BAD_ATTESTATION', 'a pending attestation does not name a calendar by its https URL');
    return { kind: 'pending', uri };
  }
  return { kind: 'unknown', tag, payload };
}

function readOp(r: Reader, tag: number): Op {
  if (tag === 0xf0 || tag === 0xf1) {
    const arg = r.varbytes(MAX_MESSAGE_LENGTH);
    if (arg.length === 0) throw new OtsError('UNSUPPORTED_OP', 'an append or prepend of nothing');
    return { op: tag === 0xf0 ? 'append' : 'prepend', arg };
  }
  const unary = UNARY_TAGS[tag];
  if (!unary) throw new OtsError('UNSUPPORTED_OP', `operation 0x${tag.toString(16)}`);
  return { op: unary };
}

function readTimestamp(r: Reader, message: Uint8Array, depth: number): Timestamp {
  if (depth > MAX_DEPTH) throw new OtsError('TOO_DEEP', 'the proof nests too deeply');
  const stamp: Timestamp = { attestations: [], ops: [] };
  const one = (tag: number) => {
    if (tag === 0x00) {
      stamp.attestations.push(readAttestation(r));
    } else {
      const op = readOp(r, tag);
      stamp.ops.push({ op, next: readTimestamp(r, applyOp(op, message), depth + 1) });
    }
  };
  let tag = r.byte();
  while (tag === 0xff) {
    one(r.byte());
    tag = r.byte();
  }
  one(tag);
  return stamp;
}

/** Reads a detached timestamp file of a SHA-256 digest. */
export function parseProof(bytes: Uint8Array): Proof {
  if (bytes.length > MAX_PROOF_BYTES) throw new OtsError('TOO_LARGE', 'the proof is too large');
  const r = new Reader(bytes);
  const magic = r.take(OTS_MAGIC.length);
  if (!magic.every((b, i) => b === OTS_MAGIC[i])) throw new OtsError('BAD_MAGIC', 'not an OpenTimestamps proof');
  if (r.varuint() !== VERSION) throw new OtsError('BAD_VERSION', 'an OpenTimestamps proof of another version');
  if (r.byte() !== 0x08) throw new OtsError('UNSUPPORTED_OP', 'the file hash is not SHA-256');
  const digest = r.take(32);
  const timestamp = readTimestamp(r, digest, 0);
  if (!r.done()) throw new OtsError('TRAILING_BYTES', 'bytes follow the proof');
  return { digest, timestamp };
}

/** A timestamp alone, as a calendar answers, starting from `message`. */
export function parseTimestamp(bytes: Uint8Array, message: Uint8Array): Timestamp {
  const r = new Reader(bytes);
  const stamp = readTimestamp(r, message, 0);
  if (!r.done()) throw new OtsError('TRAILING_BYTES', 'bytes follow the timestamp');
  return stamp;
}

// ── Writing ──

class Writer {
  private parts: Uint8Array[] = [];
  bytes(b: Uint8Array | number[]) {
    this.parts.push(b instanceof Uint8Array ? b : new Uint8Array(b));
  }
  varuint(n: number) {
    const out: number[] = [];
    do {
      let b = n % 128;
      n = Math.floor(n / 128);
      if (n > 0) b |= 0x80;
      out.push(b);
    } while (n > 0);
    this.bytes(out);
  }
  varbytes(b: Uint8Array) {
    this.varuint(b.length);
    this.bytes(b);
  }
  result(): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(this.parts.reduce((n, part) => n + part.length, 0));
    let at = 0;
    for (const part of this.parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  }
}

const hexToBytes = (hex: Hex) => Uint8Array.from((hex.slice(2).match(/../g) ?? []).map((b) => parseInt(b, 16)));

function writeAttestation(w: Writer, a: Attestation) {
  const payload = new Writer();
  if (a.kind === 'bitcoin') payload.varuint(a.height);
  else if (a.kind === 'pending') payload.varbytes(new TextEncoder().encode(a.uri));
  else payload.bytes(a.payload);
  w.bytes(tagOf(a));
  w.varbytes(payload.result());
}

function writeOp(w: Writer, op: Op) {
  w.bytes([TAG_OF[op.op]]);
  if (op.op === 'append' || op.op === 'prepend') w.varbytes(op.arg);
}

const compareBytes = (a: Uint8Array, b: Uint8Array) => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
};
const tagOf = (a: Attestation) => hexToBytes(a.kind === 'bitcoin' ? BITCOIN_TAG : a.kind === 'pending' ? PENDING_TAG : a.tag);
/**
 * The order the reference client writes in, so a proof read and written again
 * is the same bytes: attestations by tag, then by height, calendar or payload;
 * operations by tag, then by operand.
 */
const compareAttestations = (a: Attestation, b: Attestation) => {
  const byTag = compareBytes(tagOf(a), tagOf(b));
  if (byTag !== 0) return byTag;
  if (a.kind === 'bitcoin' && b.kind === 'bitcoin') return a.height - b.height;
  if (a.kind === 'pending' && b.kind === 'pending') return compareBytes(new TextEncoder().encode(a.uri), new TextEncoder().encode(b.uri));
  if (a.kind === 'unknown' && b.kind === 'unknown') return compareBytes(a.payload, b.payload);
  return 0;
};
const compareOps = (a: Op, b: Op) => {
  if (TAG_OF[a.op] !== TAG_OF[b.op]) return TAG_OF[a.op] - TAG_OF[b.op];
  return 'arg' in a && 'arg' in b ? compareBytes(a.arg, b.arg) : 0;
};

function writeTimestamp(w: Writer, stamp: Timestamp) {
  const attestations = [...stamp.attestations].sort(compareAttestations);
  const ops = [...stamp.ops].sort((a, b) => compareOps(a.op, b.op));
  if (attestations.length === 0 && ops.length === 0) throw new OtsError('EMPTY', 'a timestamp with nothing in it');
  for (const a of attestations.slice(0, ops.length ? attestations.length : -1)) {
    w.bytes([0xff, 0x00]);
    writeAttestation(w, a);
  }
  if (ops.length === 0) {
    w.bytes([0x00]);
    writeAttestation(w, attestations[attestations.length - 1]);
    return;
  }
  for (const { op, next } of ops.slice(0, -1)) {
    w.bytes([0xff]);
    writeOp(w, op);
    writeTimestamp(w, next);
  }
  const last = ops[ops.length - 1];
  writeOp(w, last.op);
  writeTimestamp(w, last.next);
}

/** A timestamp alone, as a calendar answers it. */
export function serializeTimestamp(stamp: Timestamp): Uint8Array<ArrayBuffer> {
  const w = new Writer();
  writeTimestamp(w, stamp);
  return w.result();
}

export function serializeProof(proof: Proof): Uint8Array<ArrayBuffer> {
  const w = new Writer();
  w.bytes(OTS_MAGIC);
  w.varuint(VERSION);
  w.bytes([0x08]);
  w.bytes(proof.digest);
  writeTimestamp(w, proof.timestamp);
  return w.result();
}

// ── Walking ──

/** Every attestation, with the message the operations lead to at it. */
export function attestationsOf(proof: Proof): { attestation: Attestation; message: Uint8Array }[] {
  const out: { attestation: Attestation; message: Uint8Array }[] = [];
  const walk = (stamp: Timestamp, message: Uint8Array) => {
    for (const attestation of stamp.attestations) out.push({ attestation, message });
    for (const { op, next } of stamp.ops) walk(next, applyOp(op, message));
  };
  walk(proof.timestamp, proof.digest);
  return out;
}

/**
 * Adds what a calendar answered for a pending attestation's message to the
 * proof: the calendar's timestamp grows from the node whose message it is.
 * Returns whether anything was added.
 */
export function mergeAt(proof: Proof, message: Uint8Array, upgrade: Timestamp): boolean {
  let merged = false;
  const walk = (stamp: Timestamp, at: Uint8Array) => {
    if (compareBytes(at, message) === 0) {
      for (const a of upgrade.attestations) {
        if (!stamp.attestations.some((b) => compareAttestations(a, b) === 0)) {
          stamp.attestations.push(a);
          merged = true;
        }
      }
      for (const branch of upgrade.ops) {
        const same = stamp.ops.find((o) => compareOps(o.op, branch.op) === 0);
        if (same) {
          // Merge deeper, under the same operation.
          const before = merged;
          merged = mergeAt({ digest: applyOp(branch.op, at), timestamp: same.next }, applyOp(branch.op, at), branch.next) || before;
        } else {
          stamp.ops.push(branch);
          merged = true;
        }
      }
      return;
    }
    for (const { op, next } of stamp.ops) walk(next, applyOp(op, at));
  };
  walk(proof.timestamp, proof.digest);
  return merged;
}
