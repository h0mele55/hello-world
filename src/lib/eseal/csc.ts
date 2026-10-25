import { z } from 'zod';
import { OID, parseCertificate } from './cms';
import { basicAuth, post, providerUrl } from './http';
import { SealError, type SealSigner } from './types';

/**
 * A seal key held by a trust service provider, reached through the Cloud
 * Signature Consortium API v2 (#70): `credentials/info` for the certificate
 * chain, `credentials/authorize` for the signature activation data, and
 * `signatures/signHash` for one signature over one SHA-256 digest. The
 * document never leaves the worker; the provider sees the digest of the
 * signed attributes and nothing else.
 *
 * The worker seals unattended, so a credential whose every signature needs a
 * person (an OAuth authorisation code, or a one-time password) is refused at
 * the first seal rather than waited on.
 */

export interface CscConfig {
  /** The API's base URL, before `/credentials/info`: e.g. https://provider.example/csc/v2. */
  url: string;
  credentialId: string;
  clientId: string;
  clientSecret: string;
  /** An OAuth 2.0 token endpoint (client-credentials grant); without one, the API's own `auth/login` with HTTP Basic. */
  tokenUrl?: string;
  /** The credential's PIN, when its authorisation is explicit. */
  pin?: string;
  timeoutMs?: number;
}

const MAX_RESPONSE_BYTES = 1024 * 1024;

const Token = z.object({ access_token: z.string().min(1), expires_in: z.number().positive().optional() });
const Info = z.object({
  key: z.object({ status: z.string().optional(), algo: z.array(z.string()).optional() }).optional(),
  cert: z.object({ status: z.string().optional(), certificates: z.array(z.string().min(1)).min(1) }),
  // v2 reports the authorisation under `auth`; v1 used `authMode` and `OTP`.
  auth: z.object({ mode: z.string().optional(), objects: z.array(z.object({ type: z.string(), id: z.string().optional() })).optional() }).optional(),
  authMode: z.string().optional(),
  PIN: z.object({ presence: z.string().optional() }).optional(),
  OTP: z.object({ presence: z.string().optional() }).optional(),
});
const Sad = z.object({ SAD: z.string().min(1) });
const Signatures = z.object({ signatures: z.array(z.string().min(1)).length(1) });

const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
function unbase64(value: string, what: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value.replace(/\s+/g, ''))) throw new SealError('SIGNER_REFUSED', `${what} is not base64`);
  return new Uint8Array(Buffer.from(value, 'base64'));
}

export function cscSigner(config: CscConfig, fetchImpl: typeof fetch = fetch): SealSigner {
  const api = providerUrl(config.url, 'CSC_URL');
  const tokenUrl = config.tokenUrl ? providerUrl(config.tokenUrl, 'CSC_TOKEN_URL') : null;
  const endpoint = (path: string) => new URL(`${api.pathname.replace(/\/+$/, '')}/${path}`, api);
  const timeoutMs = config.timeoutMs ?? 15_000;
  let token: { value: string; until: number } | null = null;

  async function call<T>(url: URL, body: Record<string, unknown> | string, schema: z.ZodType<T>, headers: Record<string, string>): Promise<T> {
    const answer = await post({
      url,
      body: typeof body === 'string' ? body : JSON.stringify(body),
      headers: { accept: 'application/json', 'content-type': typeof body === 'string' ? 'application/x-www-form-urlencoded' : 'application/json', ...headers },
      side: 'SIGNER',
      timeoutMs,
      maxBytes: MAX_RESPONSE_BYTES,
      fetch: fetchImpl,
    });
    let json: unknown;
    try {
      json = JSON.parse(Buffer.from(answer.body).toString('utf8'));
    } catch {
      json = null;
    }
    if (answer.status !== 200) {
      // The provider's error code names the refusal; its description could carry anything, so it is not kept.
      const code = typeof (json as { error?: unknown } | null)?.error === 'string' ? (json as { error: string }).error.slice(0, 64) : 'no error code';
      throw new SealError('SIGNER_REFUSED', `${url.pathname} answered ${answer.status} (${code})`);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new SealError('SIGNER_REFUSED', `${url.pathname} answered with something other than the API’s reply`);
    return parsed.data;
  }

  async function bearer(): Promise<Record<string, string>> {
    if (!token || token.until <= Date.now()) {
      const answer = tokenUrl
        ? await call(
            tokenUrl,
            new URLSearchParams({ grant_type: 'client_credentials', client_id: config.clientId, client_secret: config.clientSecret, scope: 'service' }).toString(),
            Token,
            {},
          )
        : await call(endpoint('auth/login'), {}, Token, { authorization: basicAuth(config.clientId, config.clientSecret) });
      // Renewed a minute early, so a token never expires between two calls of one seal.
      token = { value: answer.access_token, until: Date.now() + Math.max(0, (answer.expires_in ?? 300) - 60) * 1000 };
    }
    return { authorization: `Bearer ${token.value}` };
  }

  async function info() {
    const answer = await call(endpoint('credentials/info'), { credentialID: config.credentialId, certificates: 'chain', certInfo: false, authInfo: true }, Info, await bearer());
    if (answer.key?.status && answer.key.status !== 'enabled') throw new SealError('SIGNER_REFUSED', `the seal key is ${answer.key.status}`);
    if (answer.cert.status && answer.cert.status !== 'valid') throw new SealError('SIGNER_REFUSED', `the seal certificate is ${answer.cert.status}`);
    const mode = answer.auth?.mode ?? answer.authMode ?? 'implicit';
    const needsOtp = answer.OTP?.presence === 'true' || (answer.auth?.objects ?? []).some((o) => o.type === 'OTP');
    if (mode === 'oauth2code' || needsOtp) throw new SealError('SIGNER_REFUSED', 'the credential needs a person to authorise each signature; an unattended seal cannot use it');
    const needsPin = answer.PIN?.presence === 'true' || (answer.auth?.objects ?? []).some((o) => o.type === 'Password');
    if (mode === 'explicit' && needsPin && !config.pin) {
      throw new SealError('SIGNER_REFUSED', 'the credential needs its PIN, and none is configured');
    }
    if (mode !== 'implicit' && mode !== 'explicit') throw new SealError('SIGNER_REFUSED', `the credential’s authorisation mode ${mode} is not one this worker knows`);
    return { certificates: answer.cert.certificates.map((c, i) => unbase64(c, `certificate ${i + 1}`)), algorithms: answer.key?.algo ?? [] };
  }

  let known: Awaited<ReturnType<typeof info>> | null = null;

  return {
    async certificates() {
      known = await info();
      return known.certificates;
    },

    async signDigest(digest) {
      known ??= await info();
      const ec = parseCertificate(known.certificates[0]).subjectPublicKeyInfo.algorithm.algorithmId === OID.ecPublicKey;
      const signAlgo = chooseSignAlgo(ec, known.algorithms);
      const hashes = [base64(digest)];
      const headers = await bearer();
      const { SAD } = await call(
        endpoint('credentials/authorize'),
        { credentialID: config.credentialId, numSignatures: 1, hashes, hashAlgorithmOID: OID.sha256, ...(config.pin ? { PIN: config.pin } : {}) },
        Sad,
        headers,
      );
      const { signatures } = await call(
        endpoint('signatures/signHash'),
        { credentialID: config.credentialId, SAD, hashes, hashAlgorithmOID: OID.sha256, signAlgo },
        Signatures,
        headers,
      );
      const signature = unbase64(signatures[0], 'the signature');
      // An ECDSA signature may come back as r and s side by side; CMS wants it DER-encoded.
      return ec && signature[0] !== 0x30 ? ecdsaDer(signature) : signature;
    },
  };
}

/** The signature algorithm to ask for: the one the key lists for SHA-256, else the bare key algorithm. */
function chooseSignAlgo(ec: boolean, listed: string[]): string {
  const [withHash, bare] = ec ? [OID.ecdsaWithSHA256, OID.ecPublicKey] : [OID.sha256WithRSA, OID.rsaEncryption];
  if (listed.length === 0 || listed.includes(withHash)) return withHash;
  if (listed.includes(bare)) return bare;
  throw new SealError('SIGNER_REFUSED', `the seal key lists no ${ec ? 'ECDSA' : 'RSA'} signature algorithm this worker uses`);
}

/** r ‖ s (as IEEE P1363 writes them) to DER Ecdsa-Sig-Value. */
export function ecdsaDer(raw: Uint8Array): Uint8Array {
  if (raw.length === 0 || raw.length % 2 !== 0 || raw.length > 132) throw new SealError('SIGNER_REFUSED', 'the ECDSA signature has an unreadable length');
  const integer = (bytes: Uint8Array) => {
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) start++;
    const body = bytes[start] & 0x80 ? [0, ...bytes.subarray(start)] : [...bytes.subarray(start)];
    return [0x02, body.length, ...body];
  };
  const half = raw.length / 2;
  const content = [...integer(raw.subarray(0, half)), ...integer(raw.subarray(half))];
  return new Uint8Array([0x30, ...(content.length < 0x80 ? [content.length] : [0x81, content.length]), ...content]);
}
