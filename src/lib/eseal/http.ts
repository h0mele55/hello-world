import { SealError } from './types';

/**
 * How the seal's providers are reached (#70): HTTPS, or plain HTTP to this
 * machine for the tests' fake providers, with a timeout and a cap on what is
 * read. A provider that does not answer, or answers 429 or 5xx, is
 * UNAVAILABLE and the copy waits for the next pass; any other refusal is
 * REFUSED and needs a person.
 */

const LOOPBACK = new Set(['127.0.0.1', '[::1]', 'localhost']);

/** A provider's URL: HTTPS, or HTTP to the loopback address. Thrown at start-up, never mid-seal. */
export function providerUrl(value: string, what: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${what} is not a URL`);
  }
  if (url.username || url.password) throw new Error(`${what} carries credentials; give them in their own settings`);
  if (url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname))) return url;
  throw new Error(`${what} must be https (plain http only to this machine)`);
}

export interface ProviderCall {
  url: URL;
  /** POST by default; a CRL is fetched with GET (#119). */
  method?: 'POST' | 'GET';
  body?: Uint8Array | string;
  headers: Record<string, string>;
  /** Which side failed, for the error's code. */
  side: 'SIGNER' | 'TIMESTAMP' | 'REVOCATION';
  timeoutMs: number;
  maxBytes: number;
  fetch: typeof fetch;
}

export interface ProviderAnswer {
  status: number;
  contentType: string;
  body: Uint8Array;
}

/** POSTs to a provider (or GETs, for a CRL). Any answer is returned, up to `maxBytes`; no answer is UNAVAILABLE. */
export async function post(call: ProviderCall): Promise<ProviderAnswer> {
  let response: Response;
  try {
    response = await call.fetch(call.url, {
      method: call.method ?? 'POST',
      headers: call.headers,
      body: call.body === undefined || typeof call.body === 'string' ? call.body : new Uint8Array(call.body),
      redirect: 'error',
      signal: AbortSignal.timeout(call.timeoutMs),
    });
  } catch {
    throw new SealError(`${call.side}_UNAVAILABLE`, `${call.url.origin} did not answer`);
  }
  const body = await readCapped(response, call);
  if (response.status === 429 || response.status >= 500) throw new SealError(`${call.side}_UNAVAILABLE`, `${call.url.origin} answered ${response.status}`);
  return { status: response.status, contentType: (response.headers.get('content-type') ?? '').toLowerCase(), body };
}

async function readCapped(response: Response, call: ProviderCall): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > call.maxBytes) throw new SealError(`${call.side}_REFUSED`, `${call.url.origin} answered with more than ${call.maxBytes} bytes`);
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > call.maxBytes) {
        await reader.cancel();
        throw new SealError(`${call.side}_REFUSED`, `${call.url.origin} answered with more than ${call.maxBytes} bytes`);
      }
      parts.push(value);
    }
  } catch (error) {
    if (error instanceof SealError) throw error;
    throw new SealError(`${call.side}_UNAVAILABLE`, `${call.url.origin} stopped answering`);
  }
  const body = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    body.set(part, at);
    at += part.length;
  }
  return body;
}

export const basicAuth = (user: string, password: string) => `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}`;
