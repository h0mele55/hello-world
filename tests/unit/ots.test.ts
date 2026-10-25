import fs from 'node:fs';
import path from 'node:path';
import { bytesToHex, hexToBytes, sha256 } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import { agreedHeader, BitcoinError, bitcoinTimeOf, checkBitcoinAttestation, esploraSource, hasProofOfWork, readHeader, targetOf, type HeaderSource } from '@/lib/ots/bitcoin';
import { submitDigest, upgradeProof } from '@/lib/ots/calendar';
import { applyOp, attestationsOf, OtsError, OTS_MAGIC, parseProof, parseTimestamp, serializeProof, serializeTimestamp, type Proof, type Timestamp } from '@/lib/ots/format';

/**
 * #66: the .ots format, the Bitcoin check and the calendar client, offline.
 * The proof is the reference client's own example, a real proof of
 * hello-world.txt; the header is block 358391's, read once from
 * blockstream.info and mempool.space (both gave these 80 bytes) and recorded
 * here, so nothing is fetched when the tests run.
 */

const FIXTURES = path.join(import.meta.dirname, '..', 'fixtures', 'ots');
const FILE = new Uint8Array(fs.readFileSync(path.join(FIXTURES, 'hello-world.txt')));
const PROOF = new Uint8Array(fs.readFileSync(path.join(FIXTURES, 'hello-world.txt.ots')));

const HEIGHT = 358391;
const BLOCK_HASH = '0x000000000000000003e892881a8cdcdc117c06d444057c98b6f04a9ee75a2319';
const HEADER = hexToBytes(
  '0x02000000b96394585a281b7e5f438fd1c9ed492645a1fd61cb3802040000000000000000007ee445d23ad061af4a36b809501fab1ac4f2d7e7a739817dd0cbb7ec661b8a1e376755f58616186272def6',
);
/** 2015-05-28T15:41:18Z, the miner's clock in that header. */
const BLOCK_TIME = 1432827678;
/** Bitcoin's genesis block: real work, at difficulty 1. */
const GENESIS = hexToBytes(
  '0x0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a29ab5f49ffff001d1dac2b7c',
);

const source = (origin: string, headers: Record<number, Uint8Array> = { [HEIGHT]: HEADER }): HeaderSource & { calls: number } => {
  const s = {
    origin,
    calls: 0,
    async header(height: number) {
      s.calls += 1;
      const bytes = headers[height];
      if (!bytes) throw new BitcoinError('UNREADABLE', `${origin} has no block ${height}`);
      return bytes;
    },
  };
  return s;
};
const explorers = () => [source('https://one.example'), source('https://two.example')] as const;

const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return error instanceof OtsError ? error.code : String(error);
  }
  return 'NO_ERROR';
};
const rejectionOf = async (promise: Promise<unknown>) =>
  promise.then(
    () => 'NO_ERROR',
    (error: unknown) => (error instanceof BitcoinError ? error.code : String(error)),
  );

describe('the .ots format', () => {
  it('reads the reference client example: the file digest and one Bitcoin attestation', () => {
    const proof = parseProof(PROOF);
    expect(bytesToHex(proof.digest)).toBe(sha256(FILE));
    const found = attestationsOf(proof);
    expect(found.map((f) => f.attestation)).toEqual([{ kind: 'bitcoin', height: HEIGHT }]);
    // The message at the attestation is the block's Merkle root as its header carries it.
    expect(bytesToHex(found[0].message)).toBe(bytesToHex(HEADER.slice(36, 68)));
  });

  it('writes a proof it read as the same bytes', () => {
    expect(bytesToHex(serializeProof(parseProof(PROOF)))).toBe(bytesToHex(PROOF));
  });

  it('refuses what it cannot read, by name', () => {
    const tamper = (at: number, byte: number) => {
      const copy = PROOF.slice();
      copy[at] = byte;
      return copy;
    };
    expect(codeOf(() => parseProof(tamper(1, 0x50)))).toBe('BAD_MAGIC');
    expect(codeOf(() => parseProof(tamper(OTS_MAGIC.length, 2)))).toBe('BAD_VERSION');
    // A SHA-1 file hash is not one this reader takes.
    expect(codeOf(() => parseProof(tamper(OTS_MAGIC.length + 1, 0x02)))).toBe('UNSUPPORTED_OP');
    expect(codeOf(() => parseProof(new Uint8Array([...PROOF, 0])))).toBe('TRAILING_BYTES');
    expect(codeOf(() => parseProof(new Uint8Array(70_000)))).toBe('TOO_LARGE');
    // Every proper prefix is refused; none reads as a shorter proof.
    for (let n = 0; n < PROOF.length; n++) expect(codeOf(() => parseProof(PROOF.slice(0, n))), `prefix ${n}`).not.toBe('NO_ERROR');
  });

  it('refuses an operation it does not know, and a proof nested past its limit', () => {
    const digest = sha256(FILE, 'bytes');
    expect(codeOf(() => parseTimestamp(new Uint8Array([0x02]), digest))).toBe('UNSUPPORTED_OP');
    expect(codeOf(() => parseTimestamp(new Uint8Array([0xf0, 0x00]), digest))).toBe('UNSUPPORTED_OP');
    const deep = new Uint8Array([...new Array(300).fill(0x08), 0x00, ...hexToBytes('0x0588960d73d71901'), 1, 1]);
    expect(codeOf(() => parseTimestamp(deep, digest))).toBe('TOO_DEEP');
  });

  it('takes a pending attestation only when it names a calendar by its https URL', () => {
    const pending = (uri: string) => {
      const encoded = new TextEncoder().encode(uri);
      return new Uint8Array([0x00, ...hexToBytes('0x83dfe30d2ef90c8e'), encoded.length + 1, encoded.length, ...encoded]);
    };
    const digest = sha256(FILE, 'bytes');
    expect(parseTimestamp(pending('https://alice.btc.calendar.opentimestamps.org'), digest).attestations).toEqual([{ kind: 'pending', uri: 'https://alice.btc.calendar.opentimestamps.org' }]);
    expect(codeOf(() => parseTimestamp(pending('http://alice.btc.calendar.opentimestamps.org'), digest))).toBe('BAD_ATTESTATION');
    expect(codeOf(() => parseTimestamp(pending('https://user@evil.example'), digest))).toBe('BAD_ATTESTATION');
  });

  it('writes attestations in the reference order: by tag, then by height, not by encoded bytes', () => {
    // 129 encodes as 81 01 and 256 as 80 02: byte order would put 256 first.
    const stamp: Timestamp = { attestations: [{ kind: 'bitcoin', height: 256 }, { kind: 'bitcoin', height: 129 }, { kind: 'pending', uri: 'https://a.example' }], ops: [] };
    const read = parseTimestamp(serializeTimestamp(stamp), new Uint8Array(32));
    expect(read.attestations).toEqual([{ kind: 'bitcoin', height: 129 }, { kind: 'bitcoin', height: 256 }, { kind: 'pending', uri: 'https://a.example' }]);
  });

  it('applies each operation as the reference client does', () => {
    const m = new Uint8Array([0xab, 0xcd]);
    expect(applyOp({ op: 'reverse' }, m)).toEqual(new Uint8Array([0xcd, 0xab]));
    expect(new TextDecoder().decode(applyOp({ op: 'hexlify' }, m))).toBe('abcd');
    expect(applyOp({ op: 'append', arg: new Uint8Array([1]) }, m)).toEqual(new Uint8Array([0xab, 0xcd, 1]));
    expect(applyOp({ op: 'prepend', arg: new Uint8Array([1]) }, m)).toEqual(new Uint8Array([1, 0xab, 0xcd]));
    expect(codeOf(() => applyOp({ op: 'append', arg: new Uint8Array(4096) }, m))).toBe('TOO_LARGE');
  });
});

describe('the Bitcoin check', () => {
  it('reads a header: its hash, Merkle root and time', () => {
    const header = readHeader(HEADER);
    expect(header.hash).toBe(BLOCK_HASH);
    expect(header.time).toBe(BLOCK_TIME);
    expect(hasProofOfWork(header)).toBe(true);
    expect(readHeader(GENESIS).hash).toBe('0x000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f');
  });

  it('refuses a header without the work, and one whose work is too easy', () => {
    const forged = HEADER.slice();
    forged[76] ^= 1; // the nonce
    expect(hasProofOfWork(readHeader(forged))).toBe(false);
    // The genesis block meets its own target, difficulty 1, far below any block a calendar uses.
    expect(targetOf(0x1d00ffff)).toBe(0xffffn << 208n);
    expect(hasProofOfWork(readHeader(GENESIS))).toBe(false);
    expect(targetOf(0x1d80ffff)).toBeNull();
    expect(() => readHeader(HEADER.slice(1))).toThrow(BitcoinError);
  });

  it('verifies the example proof against block 358391, read from two explorers', async () => {
    expect(await bitcoinTimeOf(parseProof(PROOF), explorers())).toEqual({ height: HEIGHT, blockHash: BLOCK_HASH, time: BLOCK_TIME });
  });

  it('is NOT_IN_BLOCK when the proof leads anywhere but the Merkle root', async () => {
    const message = readHeader(HEADER).merkleRoot.slice();
    message[0] ^= 1;
    expect(await rejectionOf(checkBitcoinAttestation(message, HEIGHT, explorers()))).toBe('NOT_IN_BLOCK');
    expect(await rejectionOf(checkBitcoinAttestation(message.slice(1), HEIGHT, explorers()))).toBe('NOT_IN_BLOCK');
  });

  it('needs both explorers, and the same 80 bytes from each', async () => {
    const forged = HEADER.slice();
    forged[76] ^= 1;
    expect(await rejectionOf(agreedHeader([source('https://one.example'), source('https://two.example', { [HEIGHT]: forged })], HEIGHT))).toBe('DISAGREE');
    expect(await rejectionOf(agreedHeader([source('https://one.example'), source('https://two.example', {})], HEIGHT))).toBe('UNREADABLE');
    expect(await rejectionOf(agreedHeader([source('https://one.example'), source('https://one.example')], HEIGHT))).toBe('DISAGREE');
    // Both agreeing on a header with no work is not a block.
    expect(await rejectionOf(agreedHeader([source('https://one.example', { [HEIGHT]: forged }), source('https://two.example', { [HEIGHT]: forged })], HEIGHT))).toBe('BAD_HEADER');
  });

  it('reads each height once per pass, and forgets a failure', async () => {
    const pair = explorers();
    const cache = new Map();
    await agreedHeader(pair, HEIGHT, cache);
    await agreedHeader(pair, HEIGHT, cache);
    expect(pair[0].calls).toBe(1);
    expect(await rejectionOf(agreedHeader(pair, 1, cache))).toBe('UNREADABLE');
    await Promise.resolve();
    expect(cache.has(1)).toBe(false);
  });

  it('reads an Esplora explorer: the hash at the height, then the header that hashes to it', async () => {
    const answers: Record<string, string> = {
      [`/block-height/${HEIGHT}`]: BLOCK_HASH.slice(2),
      [`/block/${BLOCK_HASH.slice(2)}/header`]: bytesToHex(HEADER).slice(2),
    };
    const fetcher = (bodies: Record<string, string>, status = 200) =>
      vi.fn(async (url: string | URL | Request) => {
        const body = bodies[new URL(String(url)).pathname.replace(/^\/api/, '')];
        return body === undefined ? new Response('', { status: 404 }) : new Response(body, { status });
      });
    const good = fetcher(answers);
    expect(bytesToHex(await esploraSource('https://explorer.example/api', good as unknown as typeof fetch).header(HEIGHT))).toBe(bytesToHex(HEADER));
    expect(good.mock.calls.map(([url]) => String(url))).toEqual([`https://explorer.example/api/block-height/${HEIGHT}`, `https://explorer.example/api/block/${BLOCK_HASH.slice(2)}/header`]);

    // A header that is not the block the explorer named.
    const swapped = { ...answers, [`/block/${BLOCK_HASH.slice(2)}/header`]: bytesToHex(GENESIS).slice(2) };
    expect(await rejectionOf(esploraSource('https://explorer.example/api', fetcher(swapped) as unknown as typeof fetch).header(HEIGHT))).toBe('UNREADABLE');
    // Something that is not a hash.
    expect(await rejectionOf(esploraSource('https://explorer.example/api', fetcher({ [`/block-height/${HEIGHT}`]: '<html>' }) as unknown as typeof fetch).header(HEIGHT))).toBe('UNREADABLE');
    expect(await rejectionOf(esploraSource('https://explorer.example/api', fetcher(answers, 503) as unknown as typeof fetch).header(HEIGHT))).toBe('UNREADABLE');
  });
});

// ── A fake calendar ──

const ALICE = 'https://alice.example';
const BOB = 'https://bob.example';

/** What a calendar answers at once: its own time prepended, hashed, and "pending at me". */
function pendingAnswer(uri: string): Timestamp {
  return { attestations: [], ops: [{ op: { op: 'prepend', arg: new Uint8Array([0x5f, 0x00, 0x00, 0x01]) }, next: { attestations: [], ops: [{ op: { op: 'sha256' }, next: { attestations: [{ kind: 'pending', uri }], ops: [] } }] } }] };
}

function fakeCalendars(routes: Record<string, (body: Uint8Array | null) => Response>) {
  const seen: { url: string; body: Uint8Array | null }[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? new Uint8Array(init.body as Uint8Array) : null;
    seen.push({ url: String(url), body });
    const route = Object.entries(routes).find(([prefix]) => String(url).startsWith(prefix));
    return route ? route[1](body) : new Response('', { status: 404 });
  });
  return { fetch: fetchImpl as unknown as typeof fetch, seen };
}

/**
 * The example proof with its path cut `depth` operations below the digest and
 * replaced by "pending at ALICE": what the proof looked like before Bitcoin
 * confirmed it. Returns the message at the cut and the part cut off, which is
 * what the calendar answers later.
 */
function cutExample(depth: number): { pending: Proof; message: Uint8Array; rest: Timestamp } {
  const proof = parseProof(PROOF);
  let node = proof.timestamp;
  let message = proof.digest;
  for (let i = 0; i < depth; i++) {
    expect(node.ops.length).toBe(1);
    message = applyOp(node.ops[0].op, message);
    node = node.ops[0].next;
  }
  const rest: Timestamp = { attestations: node.attestations, ops: node.ops };
  const cutNode = node as { attestations: Timestamp['attestations']; ops: Timestamp['ops'] };
  cutNode.attestations = [{ kind: 'pending', uri: ALICE }];
  cutNode.ops = [];
  return { pending: proof, message, rest };
}

describe('the calendar client', () => {
  it('sends each calendar a hash of the digest and a nonce, never the digest, and keeps every answer', async () => {
    const digest = sha256(new TextEncoder().encode('manifest'), 'bytes');
    const nonce = new Uint8Array(16).fill(7);
    const calendars = fakeCalendars({
      [`${ALICE}/digest`]: () => new Response(serializeTimestamp(pendingAnswer(ALICE))),
      [`${BOB}/digest`]: () => new Response(serializeTimestamp(pendingAnswer(BOB))),
      ['https://down.example/digest']: () => new Response('', { status: 503 }),
      ['https://chatty.example/digest']: () => new Response(new Uint8Array(20_000)),
      ['https://garbled.example/digest']: () => new Response(new Uint8Array([0x02])),
    });
    const result = await submitDigest(digest, { calendars: [ALICE, BOB, 'https://down.example', 'https://chatty.example', 'https://garbled.example'], fetch: calendars.fetch }, nonce);

    const commitment = sha256(new Uint8Array([...digest, ...nonce]));
    expect(calendars.seen.every((s) => s.body && bytesToHex(s.body) === commitment)).toBe(true);
    expect(calendars.seen.some((s) => s.body && bytesToHex(s.body) === bytesToHex(digest))).toBe(false);
    expect(result.accepted).toEqual([ALICE, BOB]);
    expect(result.refused).toEqual([
      { calendar: 'https://down.example', reason: 'HTTP_ERROR' },
      { calendar: 'https://chatty.example', reason: 'TOO_LARGE' },
      { calendar: 'https://garbled.example', reason: 'BAD_ANSWER' },
    ]);
    // The proof starts at the digest, and survives being written and read.
    const again = parseProof(serializeProof(result.proof));
    expect(bytesToHex(again.digest)).toBe(bytesToHex(digest));
    expect(attestationsOf(again).map((a) => a.attestation)).toEqual([
      { kind: 'pending', uri: ALICE },
      { kind: 'pending', uri: BOB },
    ]);
  });

  it('upgrades the example from pending to Bitcoin, and the upgraded proof verifies against block 358391', async () => {
    const { pending, message, rest } = cutExample(3);
    expect(await bitcoinTimeOf(pending, explorers())).toBeNull();
    const calendars = fakeCalendars({ [`${ALICE}/timestamp/${bytesToHex(message).slice(2)}`]: () => new Response(serializeTimestamp(rest)) });

    const upgrade = await upgradeProof(pending, { calendars: [ALICE], fetch: calendars.fetch });
    expect(upgrade).toEqual({ changed: true, pending: [], failed: [] });
    expect(await bitcoinTimeOf(parseProof(serializeProof(pending)), explorers())).toEqual({ height: HEIGHT, blockHash: BLOCK_HASH, time: BLOCK_TIME });
    // Asking again adds nothing.
    expect((await upgradeProof(pending, { calendars: [ALICE], fetch: calendars.fetch })).changed).toBe(false);
  });

  it('reports "not yet" and failures, and never asks a calendar it does not list', async () => {
    const { pending } = cutExample(3);
    const notYet = fakeCalendars({});
    expect(await upgradeProof(pending, { calendars: [ALICE], fetch: notYet.fetch })).toEqual({ changed: false, pending: [ALICE], failed: [] });
    const broken = fakeCalendars({ [ALICE]: () => new Response(new Uint8Array([0x02])) });
    expect(await upgradeProof(pending, { calendars: [ALICE], fetch: broken.fetch })).toEqual({ changed: false, pending: [], failed: [{ calendar: ALICE, reason: 'BAD_ANSWER' }] });
    const elsewhere = fakeCalendars({});
    expect(await upgradeProof(pending, { calendars: [BOB], fetch: elsewhere.fetch })).toEqual({ changed: false, pending: [], failed: [] });
    expect(elsewhere.seen).toEqual([]);
  });

  it('refuses to timestamp anything but a 32-byte digest', async () => {
    await expect(submitDigest(new Uint8Array(20), { calendars: [], fetch: fakeCalendars({}).fetch })).rejects.toThrow(OtsError);
  });
});
