import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/auth';

/**
 * Phase 5 hardening (#52): every mutating route checks the caller's role on
 * the server. Each route is called as a signed-in VIEWER and must answer 403
 * FORBIDDEN before doing anything; the routes are found from git, so a new
 * one is held to this without anyone remembering to add it.
 */

vi.mock('server-only', () => ({}));
const session = vi.hoisted(() => ({ user: null as SessionUser | null }));
vi.mock('@/auth', () => ({ currentUser: async () => session.user }));

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const WRITES = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;
/** Routes whose writes are not a firm's act, with the reason. */
const EXEMPT: Record<string, string> = {
  'src/app/api/auth/[...nextauth]/route.ts': 'NextAuth itself: signing in and out, before there is a role',
};

const routeFiles = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'src/app/api'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n')
  .filter((file) => file.endsWith('/route.ts'));

const user = (role: SessionUser['role'], mfa: SessionUser['mfa'] = 'NOT_REQUIRED'): SessionUser => ({ id: 'u1', email: 'u@example.test', name: 'U', role, orgId: 'o1', mfa });
const ctx = { params: Promise.resolve({ versionId: 'v1', engagementId: 'e1' }) };

async function writesOf(file: string) {
  const mod = (await import(path.join(ROOT, file))) as Record<string, unknown>;
  return WRITES.filter((method) => typeof mod[method] === 'function').map((method) => ({ method, call: mod[method] as (req: NextRequest, ctx: unknown) => Promise<Response> }));
}

async function call(file: string, method: string, fn: (req: NextRequest, ctx: unknown) => Promise<Response>) {
  // No Origin header: a same-site request from the app, so a refusal can only be the role's.
  const req = new NextRequest(`http://app.test/${file}`, { method, headers: { 'content-type': 'application/json' }, body: '{}' });
  const response = await fn(req, ctx);
  return { status: response.status, body: (await response.json()) as { error?: string } };
}

beforeEach(() => {
  session.user = null;
});

describe('the role check on every mutating route', () => {
  it('finds the routes', () => {
    expect(routeFiles.length).toBeGreaterThan(5);
  });

  it.each(routeFiles.filter((file) => !EXEMPT[file]))('%s refuses a VIEWER with 403', async (file) => {
    const writes = await writesOf(file);
    for (const { method, call: fn } of writes) {
      session.user = user('VIEWER');
      expect(await call(file, method, fn), `${method} ${file}`).toEqual({ status: 403, body: { error: 'FORBIDDEN' } });
    }
  });

  it('refuses everything but setting up the second factor to an approver or admin who has none yet', async () => {
    const approve = (await writesOf('src/app/api/versions/[versionId]/approve/route.ts'))[0];
    const chainMode = (await writesOf('src/app/api/org/chain-mode/route.ts'))[0];
    for (const role of ['APPROVER', 'ADMIN'] as const) {
      session.user = user(role, 'ENROLL');
      expect(await call('approve', approve.method, approve.call)).toEqual({ status: 403, body: { error: 'MFA_REQUIRED' } });
      expect(await call('chain-mode', chainMode.method, chainMode.call)).toEqual({ status: 403, body: { error: 'MFA_REQUIRED' } });
    }
  });

  it('refuses a caller who is not signed in with 401', async () => {
    const approve = (await writesOf('src/app/api/versions/[versionId]/approve/route.ts'))[0];
    expect(await call('approve', approve.method, approve.call)).toEqual({ status: 401, body: { error: 'UNAUTHENTICATED' } });
  });
});

describe('the mutation rate limit', () => {
  it('refuses a user their 61st write in a minute, says when to come back, and leaves reads and other users alone', async () => {
    const { handler } = await import('@/lib/http');
    const route = handler(async () => NextResponse.json({ ok: true }), { may: 'prepare' });
    const request = (method: string) => new NextRequest('http://app.test/api/thing', { method });
    session.user = { ...user('PREPARER'), id: 'busy-preparer' };
    for (let i = 0; i < 60; i++) expect((await route(request('POST'), {})).status, `write ${i + 1}`).toBe(200);
    const refused = await route(request('POST'), {});
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: 'RATE_LIMITED' });
    expect(Number(refused.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect((await route(request('GET'), {})).status).toBe(200);
    session.user = { ...user('PREPARER'), id: 'another-preparer' };
    expect((await route(request('POST'), {})).status).toBe(200);
  });
});
