import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { GET } from '@/app/reanchor/[index]/route';
import { proxy } from '@/proxy';
import { LOOKUP_PER_ADDRESS } from '@/lib/rate-limit';

/**
 * /reanchor/<n> (#126): the n-th file in REANCHOR_ARCHIVES, as it is on disk,
 * for /verify to check in the browser. Nothing but an index in range is
 * served, an unreadable file never names its path, and the proxy holds the
 * route to the lookup page's rate limit.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reanchor-route-'));
const archive = path.join(dir, 'archive.json');
fs.writeFileSync(archive, JSON.stringify({ format: 'reanchor-archive/1', records: [] }));
const saved = { archives: process.env.REANCHOR_ARCHIVES, trust: process.env.TRUST_PROXY_HEADERS };

afterEach(() => {
  process.env.REANCHOR_ARCHIVES = saved.archives;
  process.env.TRUST_PROXY_HEADERS = saved.trust;
  if (saved.archives === undefined) delete process.env.REANCHOR_ARCHIVES;
  if (saved.trust === undefined) delete process.env.TRUST_PROXY_HEADERS;
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const get = (index: string) => GET(new Request(`http://app.test/reanchor/${index}`), { params: Promise.resolve({ index }) });

describe('the re-anchor archive route', () => {
  it('serves the n-th archive as it is on disk', async () => {
    process.env.REANCHOR_ARCHIVES = `${archive}, ${path.join(dir, 'missing.json')}`;
    const response = await get('0');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(fs.readFileSync(archive));
  });

  it('serves nothing but an index in range, and never names a file it cannot read', async () => {
    process.env.REANCHOR_ARCHIVES = `${archive},${path.join(dir, 'missing.json')}`;
    for (const index of ['2', '-1', '01', '1e0', '..', 'archive.json']) expect((await get(index)).status, index).toBe(404);
    const unreadable = await get('1');
    expect(unreadable.status).toBe(503);
    expect(await unreadable.text()).not.toContain(dir);
    delete process.env.REANCHOR_ARCHIVES;
    expect((await get('0')).status).toBe(404);
  });

  it('is rate-limited with the lookup page', () => {
    process.env.TRUST_PROXY_HEADERS = '1';
    const from = (address: string) => proxy(new NextRequest('http://app.test/reanchor/0', { headers: { 'x-forwarded-for': address } }));
    for (let i = 0; i < LOOKUP_PER_ADDRESS; i++) expect(from('203.0.113.7').status).not.toBe(429);
    const refused = from('203.0.113.7');
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toMatch(/^\d+$/);
    expect(from('203.0.113.8').status).not.toBe(429);
  });
});
