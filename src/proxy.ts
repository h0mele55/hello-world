import { NextResponse, type NextRequest } from 'next/server';
import { appCsp, verifierCsp } from '@/lib/csp';
import { EXPLORER_ORIGINS } from '@/lib/ots/explorers';
import { clientAddressOf, takeLookup } from '@/lib/rate-limit';
import { verifierRpcUrls } from '@/lib/verify-setup';

/**
 * Every page gets a nonce-based CSP (#84). The public verifier's pages may
 * also reach their two RPC endpoints and the two Bitcoin explorers (#66);
 * every other page, this origin only. The lookup page is rate-limited, since
 * it reads the chain on the server for every request, and so are the public
 * proof route, which reads the database, and the re-anchor archives (#126),
 * which can be large.
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (pathname.startsWith('/r/') || pathname.startsWith('/ots/') || pathname.startsWith('/reanchor/')) {
    const taken = takeLookup(clientAddressOf(request.headers));
    if (!taken.ok) {
      return new NextResponse('Too many requests. Try again shortly.', {
        status: 429,
        headers: { 'Retry-After': String(taken.retryAfterSeconds), 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }
  }

  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  const dev = process.env.NODE_ENV === 'development';
  let csp: string;
  if (pathname === '/verify' || pathname.startsWith('/r/')) {
    const urls = verifierRpcUrls();
    csp = verifierCsp({ nonce, rpcOrigins: typeof urls === 'string' ? [] : urls.map((url) => new URL(url).origin), explorerOrigins: EXPLORER_ORIGINS, dev });
  } else {
    csp = appCsp({ nonce, dev });
  }
  // Next.js reads the nonce from the request's CSP and puts it on its own scripts.
  const headers = new Headers(request.headers);
  headers.set('Content-Security-Policy', csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

/**
 * Every page; not the API (JSON, and PDFs a browser may open in its own
 * viewer), Next.js's static files, or a file in public/ (any path with a dot,
 * such as /pdf.worker.min.mjs).
 */
export const config = { matcher: ['/((?!api/|_next/|.*\\.[^/]+$).*)'] };
