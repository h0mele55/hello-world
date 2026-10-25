import { NextResponse, type NextRequest } from 'next/server';
import { verifierCsp } from '@/lib/csp';
import { clientAddressOf, takeLookup } from '@/lib/rate-limit';
import { verifierRpcUrls } from '@/lib/verify-setup';

/**
 * The public verifier's pages: a nonce-based CSP that lets the page reach
 * only this origin and its two RPC endpoints, and a rate limit on the lookup
 * page, which reads the chain on the server for every request.
 */
export function proxy(request: NextRequest) {
  if (request.nextUrl.pathname.startsWith('/r/')) {
    const taken = takeLookup(clientAddressOf(request.headers));
    if (!taken.ok) {
      return new NextResponse('Too many requests. Try again shortly.', {
        status: 429,
        headers: { 'Retry-After': String(taken.retryAfterSeconds), 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }
  }

  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  const urls = verifierRpcUrls();
  const csp = verifierCsp({
    nonce,
    rpcOrigins: typeof urls === 'string' ? [] : urls.map((url) => new URL(url).origin),
    dev: process.env.NODE_ENV === 'development',
  });
  // Next.js reads the nonce from the request's CSP and puts it on its own scripts.
  const headers = new Headers(request.headers);
  headers.set('Content-Security-Policy', csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = { matcher: ['/verify', '/r/:path*'] };
