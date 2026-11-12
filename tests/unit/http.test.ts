import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/auth';

/**
 * The wrapper every route goes through (#146): a write from another site is
 * refused, a JSON body is read up to a cap however it is sent, a refusal is a
 * named code with its status, and nothing else leaks.
 */

vi.mock('server-only', () => ({}));
const session = vi.hoisted(() => ({ user: null as SessionUser | null }));
vi.mock('@/auth', () => ({ currentUser: async () => session.user }));

const { ERROR_CODES, handler, pdfResponse, readJson, JSON_BODY_LIMIT } = await import('@/lib/http');
const { KNOWN_ERRORS } = await import('@/components/reports/error-message');
const { IntakeError } = await import('@/lib/reports/intake');
const { MfaError } = await import('@/lib/mfa');

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const approver: SessionUser = { id: 'u1', email: 'a@example.test', name: 'A', role: 'APPROVER', orgId: 'o1', mfa: 'VERIFIED' };
const json = async (response: Response) => ({ status: response.status, body: (await response.json()) as { error?: string } });

/** A body sent in chunks, with no Content-Length, as a client streaming it would. */
function streamed(bytes: number): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent >= bytes) return controller.close();
      const chunk = new Uint8Array(Math.min(16 * 1024, bytes - sent)).fill(0x20);
      sent += chunk.length;
      controller.enqueue(chunk);
    },
  });
}
const request = (init: { method?: string; headers?: Record<string, string>; body?: BodyInit | null } = {}) =>
  new NextRequest('http://app.test/api/thing', { method: init.method ?? 'POST', headers: init.headers ?? {}, body: init.body ?? null, duplex: 'half' } as ConstructorParameters<typeof NextRequest>[1]);

let n = 0;
beforeEach(() => {
  // A user of its own per test: the write rate is per user.
  session.user = { ...approver, id: `u${++n}` };
});

describe('reading a JSON body (#146)', () => {
  const echo = handler(async (req) => Response.json({ got: await readJson(req) }));

  it('reads a body within the cap', async () => {
    expect(await json(await echo(request({ body: JSON.stringify({ mode: 'LIVE' }) }), {}))).toEqual({ status: 200, body: { got: { mode: 'LIVE' } } });
    expect(await json(await echo(request({ body: 'not json' }), {}))).toEqual({ status: 200, body: { got: null } });
  });

  it('refuses a body over the cap, streamed with no length, without reading it all', async () => {
    expect(await json(await echo(request({ body: streamed(JSON_BODY_LIMIT + 1) }), {}))).toEqual({ status: 413, body: { error: 'TOO_LARGE' } });
  });

  it('refuses one whose declared length is smaller than what is sent, or larger than the cap', async () => {
    const big = new TextEncoder().encode(`{"a":"${'x'.repeat(JSON_BODY_LIMIT)}"}`);
    expect(await json(await echo(request({ headers: { 'content-length': '10' }, body: streamed(big.length) }), {}))).toEqual({ status: 413, body: { error: 'TOO_LARGE' } });
    expect(await json(await echo(request({ headers: { 'content-length': String(JSON_BODY_LIMIT + 1) }, body: '{}' }), {}))).toEqual({ status: 413, body: { error: 'TOO_LARGE' } });
  });

  it('is how every route reads JSON: none calls req.json(), which buffers whatever is sent', () => {
    const routes = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'src/app/api'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n')
      .filter((file) => file.endsWith('/route.ts'));
    const offenders = routes.filter((file) => /\breq\.json\(|\brequest\.json\(/.test(fs.readFileSync(path.join(ROOT, file), 'utf8')));
    expect(offenders).toEqual([]);
  });
});

describe('the wrapper (#146)', () => {
  const ok = handler(async () => Response.json({ ok: true }));

  it('refuses a write from another site, and a sign-in that is missing or still enrolling', async () => {
    expect(await json(await ok(request({ headers: { origin: 'https://evil.example', host: 'app.test' } }), {}))).toEqual({ status: 403, body: { error: 'CROSS_ORIGIN' } });
    expect(await json(await ok(request({ headers: { 'sec-fetch-site': 'cross-site' } }), {}))).toEqual({ status: 403, body: { error: 'CROSS_ORIGIN' } });
    expect(await json(await ok(request({ headers: { origin: 'not a url' } }), {}))).toEqual({ status: 403, body: { error: 'CROSS_ORIGIN' } });
    expect((await ok(request({ headers: { origin: 'http://app.test', host: 'app.test' } }), {})).status).toBe(200);
    session.user = null;
    expect(await json(await ok(request(), {}))).toEqual({ status: 401, body: { error: 'UNAUTHENTICATED' } });
    session.user = { ...approver, id: `u${++n}`, mfa: 'ENROLL' };
    expect(await json(await ok(request(), {}))).toEqual({ status: 403, body: { error: 'MFA_REQUIRED' } });
    expect((await handler(async () => Response.json({}), { duringMfaEnrollment: true })(request(), {})).status).toBe(200);
  });

  it('holds writes to a rate, with Retry-After', async () => {
    let last: Response | null = null;
    for (let i = 0; i < 61; i++) last = await ok(request(), {});
    expect(last!.status).toBe(429);
    expect(last!.headers.get('Retry-After')).toMatch(/^\d+$/);
    expect((await json(last!)).body).toEqual({ error: 'RATE_LIMITED' });
  });

  it('turns a named refusal into its status, and anything else into INTERNAL with no detail', async () => {
    const throwing = (error: unknown) => handler(async () => Promise.reject(error), {});
    expect(await json(await throwing(new IntakeError('NOT_FOUND'))(request({ method: 'GET' }), {}))).toEqual({ status: 404, body: { error: 'NOT_FOUND' } });
    expect(await json(await throwing(new MfaError('CODE_INVALID'))(request({ method: 'GET' }), {}))).toEqual({ status: 422, body: { error: 'CODE_INVALID' } });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await json(await throwing(new Error('the opinion text, say'))(request({ method: 'GET' }), {}))).toEqual({ status: 500, body: { error: 'INTERNAL' } });
    expect(spy.mock.calls.flat().join(' ')).not.toContain('the opinion text');
    spy.mockRestore();
  });
});

describe('serving a PDF (#146)', () => {
  it('as a sandboxed attachment, never inline, sniffed or cached', () => {
    const response = pdfResponse(new Uint8Array([0x25, 0x50, 0x44, 0x46]), 'report-v2-"anchored".pdf');
    expect(Object.fromEntries(response.headers)).toMatchObject({
      'content-type': 'application/pdf',
      'content-disposition': 'attachment; filename="report-v2-_anchored_.pdf"',
      'content-security-policy': "sandbox; default-src 'none'",
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    });
  });

  it('is how every route serves one', () => {
    const routes = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'src/app/api'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n')
      .filter((file) => file.endsWith('/route.ts'));
    // A route answering with a PDF of its own making, rather than through pdfResponse.
    const own = routes.filter((file) => /['"]Content-Type['"]:\s*['"]application\/pdf/i.test(fs.readFileSync(path.join(ROOT, file), 'utf8')));
    expect(own).toEqual([]);
  });
});

describe('the console’s words for a refusal (#146)', () => {
  it('has one, in English and Bulgarian, for every code a route can answer with', () => {
    const missing = ERROR_CODES.filter((code) => !KNOWN_ERRORS.has(code));
    expect(missing).toEqual([]);
    for (const locale of ['en', 'bg']) {
      const errors = (JSON.parse(fs.readFileSync(path.join(ROOT, 'messages', `${locale}.json`), 'utf8')) as { errors: Record<string, unknown> }).errors;
      expect(ERROR_CODES.filter((code) => typeof errors[code] !== 'string'), locale).toEqual([]);
    }
  });
});
