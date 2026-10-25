import { describe, expect, it } from 'vitest';
import { appCsp, verifierCsp } from '@/lib/csp';
import { clientAddressOf, createLimiter, LOOKUP_PER_ADDRESS, LOOKUP_TOTAL, takeLookup } from '@/lib/rate-limit';

describe('the lookup rate limit', () => {
  it('refuses the 61st request in a minute, says when to come back, and lets the client in once the window has passed', () => {
    const limiter = createLimiter({ limit: 60, windowMs: 60_000 });
    for (let i = 0; i < 60; i++) expect(limiter.take('a', 1_000 + i)).toEqual({ ok: true });
    expect(limiter.take('a', 30_000)).toEqual({ ok: false, retryAfterSeconds: 31 });
    expect(limiter.take('b', 30_000)).toEqual({ ok: true });
    expect(limiter.take('a', 61_000)).toEqual({ ok: true });
  });

  it('holds every address to 60 a minute and all of them together to 600', () => {
    const t = 5_000_000;
    for (let i = 0; i < LOOKUP_PER_ADDRESS; i++) expect(takeLookup('198.51.100.1', t).ok).toBe(true);
    expect(takeLookup('198.51.100.1', t).ok).toBe(false);
    let admitted = LOOKUP_PER_ADDRESS;
    for (let i = 0; admitted < LOOKUP_TOTAL; i++) if (takeLookup(`198.51.100.${2 + (i % 50)}`, t).ok) admitted++;
    expect(takeLookup('198.51.100.200', t).ok).toBe(false);
    expect(takeLookup(null, t).ok).toBe(false);
  });

  it('trusts X-Forwarded-For only behind a proxy that overwrites it', () => {
    const headers = new Headers({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' });
    expect(clientAddressOf(headers, {})).toBeNull();
    expect(clientAddressOf(headers, { TRUST_PROXY_HEADERS: '1' })).toBe('203.0.113.7');
    expect(clientAddressOf(new Headers(), { TRUST_PROXY_HEADERS: '1' })).toBeNull();
  });
});

describe("the verifier's Content Security Policy", () => {
  const csp = verifierCsp({ nonce: 'abc123', rpcOrigins: ['https://rpc.one.example', 'https://rpc.two.example', 'https://rpc.one.example'] });
  const directive = (name: string) => csp.split('; ').find((d) => d.startsWith(`${name} `));

  it('runs scripts only by nonce, and never inline or eval in a build', () => {
    expect(directive('script-src')).toBe("script-src 'self' 'nonce-abc123' 'strict-dynamic'");
    expect(csp).not.toContain('unsafe-eval');
    expect(verifierCsp({ nonce: 'x', rpcOrigins: [], dev: true })).toContain("'unsafe-eval'");
  });

  it('connects only to its own origin and the two RPC endpoints, and frames nothing', () => {
    expect(directive('connect-src')).toBe("connect-src 'self' https://rpc.one.example https://rpc.two.example");
    expect(directive('worker-src')).toBe("worker-src 'self' blob:");
    expect(directive('object-src')).toBe("object-src 'none'");
    expect(directive('frame-ancestors')).toBe("frame-ancestors 'none'");
  });
});

describe("the signed-in app's Content Security Policy (#84)", () => {
  const csp = appCsp({ nonce: 'def456' });
  const directive = (name: string) => csp.split('; ').find((d) => d.startsWith(`${name} `));

  it('runs scripts only by nonce, connects to its own origin only, and is framed by nothing', () => {
    expect(directive('script-src')).toBe("script-src 'self' 'nonce-def456' 'strict-dynamic'");
    expect(csp).not.toContain('unsafe-eval');
    expect(appCsp({ nonce: 'x', dev: true })).toContain("'unsafe-eval'");
    expect(directive('connect-src')).toBe("connect-src 'self'");
    expect(directive('worker-src')).toBe("worker-src 'self'");
    expect(directive('img-src')).toBe("img-src 'self' data: blob:");
    expect(directive('object-src')).toBe("object-src 'none'");
    expect(directive('form-action')).toBe("form-action 'self'");
    expect(directive('frame-ancestors')).toBe("frame-ancestors 'none'");
  });
});
