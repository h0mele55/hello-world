import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { SealError } from '@/lib/eseal/types';
import { sealPdf } from '@/lib/eseal/pades';
import { isolationStats, ISOLATED_CONCURRENCY, runIsolated } from '@/lib/pdf/isolated';
import { stampPdf, StampError } from '@/lib/stamp';
import type { StampFields } from '@/lib/stamp-fields';

/**
 * #154: every load of a stored PDF runs in a child with a heap cap, a memory
 * cap that also counts what inflation allocates outside the heap, a timeout
 * and an empty environment; at most a few such children run at once.
 */

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const fixture = (name: string) => new Uint8Array(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'pdf', name)));
const PROBE = path.join(ROOT, 'tests', 'helpers', 'isolated-probe-child.mjs');

/**
 * A real report with one more object appended: an object stream nothing
 * references, which inflates to `inflated` bytes. pdf.js never reads it;
 * pdf-lib inflates every object stream it finds.
 */
async function inflationBomb(inflated: number): Promise<Uint8Array> {
  const header = Buffer.from('900 0 ', 'latin1');
  const deflate = zlib.createDeflate({ level: 9 });
  const parts: Buffer[] = [];
  deflate.on('data', (chunk: Buffer) => parts.push(chunk));
  const spaces = Buffer.alloc(1 << 20, 0x20);
  deflate.write(header);
  for (let i = 0; i < inflated >> 20; i++) deflate.write(spaces);
  deflate.write(Buffer.from('null', 'latin1'));
  await new Promise<void>((resolve) => deflate.end(resolve));
  const body = Buffer.concat(parts);
  const object = Buffer.concat([
    Buffer.from(`\n899 0 obj\n<< /Type /ObjStm /N 1 /First ${header.length} /Filter /FlateDecode /Length ${body.length} >>\nstream\n`, 'latin1'),
    body,
    Buffer.from('\nendstream\nendobj\n%%EOF\n', 'latin1'),
  ]);
  return new Uint8Array(Buffer.concat([fixture('en-unmodified.pdf'), object]));
}

const fields: StampFields = {
  stamp: 1,
  chainId: 31337,
  contract: `0x${'1'.repeat(40)}`,
  recordId: `0x${'2'.repeat(64)}`,
  txHash: `0x${'3'.repeat(64)}`,
  blockNumber: 7,
  familyId: `0x${'4'.repeat(64)}`,
  version: 1,
  verifyUrl: 'https://verify.example/verify',
  opinionType: 'UNMODIFIED',
  opinionSalt: `0x${'5'.repeat(64)}`,
  norm: 1,
};

/** The most this process grew by while `run` ran, sampled as it ran and once after. */
async function growthOf(run: () => Promise<unknown>): Promise<number> {
  const before = process.memoryUsage().rss;
  let peak = before;
  const timer = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 5);
  try {
    await run();
  } catch {
    // The caller asserts the outcome.
  } finally {
    clearInterval(timer);
  }
  return Math.max(peak, process.memoryUsage().rss) - before;
}

describe('a PDF that inflates far beyond its size (#154)', () => {
  it('is refused by stamping, in a child, and the worker does not grow', async () => {
    const bomb = await inflationBomb(400 << 20);
    expect(bomb.length).toBeLessThan(1 << 20);
    let error: unknown;
    const growth = await growthOf(() => stampPdf(bomb, fields, { memoryMb: 256 }).catch((e: unknown) => (error = e)));
    expect(error).toBeInstanceOf(StampError);
    expect((error as StampError).code).toBe('RESOURCE_LIMIT');
    expect(growth).toBeLessThan(150 << 20);
  }, 120_000);

  it('is refused by sealing before anything is signed, and the worker does not grow', async () => {
    const bomb = await inflationBomb(400 << 20);
    const never = () => Promise.reject(new Error('nothing may be signed or timestamped'));
    let error: unknown;
    const growth = await growthOf(() =>
      sealPdf(bomb, {
        signer: { sign: never, certificates: never } as never,
        timestamper: { timestamp: never } as never,
        signingTime: new Date('2026-11-12T00:00:00Z'),
        reason: 'test',
        limits: { memoryMb: 256 },
      }).catch((e: unknown) => (error = e)),
    );
    expect(error).toBeInstanceOf(SealError);
    expect((error as SealError).code).toBe('PDF_REFUSED');
    expect(growth).toBeLessThan(150 << 20);
  }, 120_000);

  it('still stamps a real report, and the same report gives the same copy', async () => {
    const original = fixture('en-unmodified.pdf');
    const a = await stampPdf(original, fields);
    const b = await stampPdf(original, fields);
    expect(Buffer.from(a.subarray(0, original.length)).equals(Buffer.from(original))).toBe(true);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });
});

describe('the isolated child (#154)', () => {
  it('starts with an empty environment: no key, password or database URL reaches it', async () => {
    process.env.ISSUER_PRIVATE_KEY = `0x${'9'.repeat(64)}`;
    try {
      const outcome = await runIsolated(PROBE, {}, { timeoutMs: 10_000, heapMb: 64, memoryMb: 512 });
      expect(outcome).toMatchObject({ ok: true });
      const env = (outcome as { answer: { env: string[] } }).answer.env;
      expect(env.filter((name) => !['SystemRoot', 'SYSTEMROOT'].includes(name))).toEqual([]);
    } finally {
      delete process.env.ISSUER_PRIVATE_KEY;
    }
  });

  it(`runs at most ${ISOLATED_CONCURRENCY} at once, and the rest wait their turn`, async () => {
    const before = isolationStats().peak;
    expect(before).toBeLessThanOrEqual(ISOLATED_CONCURRENCY);
    const outcomes = await Promise.all(Array.from({ length: 6 }, () => runIsolated(PROBE, { waitMs: 150 }, { timeoutMs: 10_000, heapMb: 64, memoryMb: 512 })));
    expect(outcomes.every((o) => o.ok)).toBe(true);
    expect(isolationStats()).toEqual({ active: 0, waiting: 0, peak: ISOLATED_CONCURRENCY });
  });

  it('is the only way the server starts a child, and the only place a stored PDF is loaded with pdf-lib', () => {
    const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'src', 'scripts'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n')
      .filter((file) => /\.(ts|tsx|mjs)$/.test(file));
    const forks = files.filter((file) => /\bfork\(/.test(fs.readFileSync(path.join(ROOT, file), 'utf8')));
    expect(forks).toEqual(['src/lib/pdf/isolated.ts']);
    const loads = files.filter((file) => /PDFDocument\.load\(/.test(fs.readFileSync(path.join(ROOT, file), 'utf8')));
    expect(loads).toEqual(['src/lib/pdf/edit-child.mjs']);
  });

  it('runs pdf.js with eval off', () => {
    expect(fs.readFileSync(path.join(ROOT, 'src', 'lib', 'pdf', 'parse-child.mjs'), 'utf8')).toMatch(/getDocument\(\{[^}]*isEvalSupported: false/);
  });
});
