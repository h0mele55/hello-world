/**
 * The Content Security Policies. Every page is served with one (src/proxy.ts),
 * and every page renders on demand, so each response carries its own nonce:
 * scripts run only with it (Next.js puts it on its own scripts) or are loaded
 * by one that did. Inline styles stay allowed: the UI kit positions popovers
 * with style attributes, which cannot carry a nonce.
 */
function policy({ nonce, connect, worker, dev }: { nonce: string; connect: readonly string[]; worker: string; dev: boolean }): string {
  return [
    "default-src 'self'",
    // 'unsafe-eval' only for the dev server's hot reload; never in a build.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src ${["'self'", ...new Set(connect)].join(' ')}`,
    `worker-src ${worker}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/**
 * The public verifier's pages (Phase 4 hardening): the page may connect only
 * to its own origin (for a report's OpenTimestamps proof), the two RPC
 * endpoints and the two Bitcoin explorers (#66), and pdf.js's worker comes
 * from this origin.
 */
export function verifierCsp({ nonce, rpcOrigins, explorerOrigins = [], dev = false }: { nonce: string; rpcOrigins: readonly string[]; explorerOrigins?: readonly string[]; dev?: boolean }): string {
  return policy({ nonce, connect: [...rpcOrigins, ...explorerOrigins], worker: "'self' blob:", dev });
}

/**
 * Every other page: the sign-in pages and the console, which show confidential
 * reports and the confirmed opinion (#84). They talk only to this origin; the
 * PDF viewer's worker is /pdf.worker.min.mjs and it draws on a canvas.
 */
export function appCsp({ nonce, dev = false }: { nonce: string; dev?: boolean }): string {
  return policy({ nonce, connect: [], worker: "'self'", dev });
}
