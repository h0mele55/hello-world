/**
 * Certificates in a PEM text, as DER, with no dependency: the app's verifier
 * setup reads the seal's published roots with this (#120), and the proxy
 * imports that module, so it must stay light. Each block must at least be one
 * whole DER SEQUENCE; src/lib/verify-core/seal.ts parses them fully.
 */
export function pemCertificates(text: string): Uint8Array[] {
  return [...text.matchAll(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g)].map((m) => {
    const b64 = m[1].replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw new Error('a PEM block is not base64');
    const der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    if (der[0] !== 0x30 || derLength(der) !== der.length) throw new Error('a PEM block is not one DER certificate');
    return der;
  });
}

function derLength(der: Uint8Array): number {
  const first = der[1];
  if (first === undefined) return -1;
  if (first < 0x80) return 2 + first;
  const n = first & 0x7f;
  if (n === 0 || n > 4) return -1;
  let length = 0;
  for (let i = 0; i < n; i++) length = length * 256 + der[2 + i];
  return 2 + n + length;
}
