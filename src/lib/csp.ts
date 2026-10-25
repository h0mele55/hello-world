/**
 * The Content Security Policy for the public verifier's pages (Phase 4
 * hardening). Scripts run only with this response's nonce (Next.js puts it on
 * its own scripts) or are loaded by one that did; the page may connect only to
 * its own origin and the two RPC endpoints; pdf.js's worker comes from this
 * origin. Inline styles stay allowed: the UI kit positions popovers with
 * style attributes, which cannot carry a nonce.
 */
export function verifierCsp({ nonce, rpcOrigins, dev = false }: { nonce: string; rpcOrigins: readonly string[]; dev?: boolean }): string {
  return [
    "default-src 'self'",
    // 'unsafe-eval' only for the dev server's hot reload; never in a build.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self' ${[...new Set(rpcOrigins)].join(' ')}`.trim(),
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}
