import { randomBytes } from 'node:crypto';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { OID, readTimestampToken } from './cms';
import { basicAuth, post, providerUrl } from './http';
import { SealError, type Timestamper } from './types';

/**
 * An RFC 3161 timestamping authority over HTTP (#70). Each request carries a
 * fresh nonce and asks for the authority's certificate; the answer is a
 * token only if its status grants it, its imprint is the digest asked for,
 * its nonce is this request's, and it names a timestamping authority. The
 * token's own bytes are kept exactly as the authority wrote them.
 */

export interface TsaConfig {
  url: string;
  /** For an authority that wants HTTP Basic authentication. */
  username?: string;
  password?: string;
  /** The policy to ask for; the token must name it. */
  policy?: string;
  timeoutMs?: number;
}

const MAX_RESPONSE_BYTES = 64 * 1024;
const GRANTED = new Set([0, 1]);
const WAITING = 3;

export function rfc3161Timestamper(config: TsaConfig, fetchImpl: typeof fetch = fetch): Timestamper {
  const url = providerUrl(config.url, 'TSA_URL');
  if ((config.username === undefined) !== (config.password === undefined)) throw new Error('give the timestamping authority both a username and a password, or neither');
  const headers: Record<string, string> = { 'content-type': 'application/timestamp-query', accept: 'application/timestamp-reply' };
  if (config.username !== undefined && config.password !== undefined) headers.authorization = basicAuth(config.username, config.password);

  return {
    async timestamp(digest) {
      if (digest.length !== 32) throw new SealError('TIMESTAMP_REFUSED', 'only a SHA-256 digest is stamped');
      const nonceBytes = randomBytes(8);
      // A positive nonce, so its DER form is these eight bytes and nothing is padded.
      nonceBytes[0] = (nonceBytes[0] & 0x7f) | 0x01;
      const nonce = BigInt(`0x${nonceBytes.toString('hex')}`);
      const request = new pkijs.TimeStampReq({
        version: 1,
        messageImprint: new pkijs.MessageImprint({
          hashAlgorithm: new pkijs.AlgorithmIdentifier({ algorithmId: OID.sha256 }),
          hashedMessage: new asn1js.OctetString({ valueHex: new Uint8Array(digest) }),
        }),
        ...(config.policy ? { reqPolicy: config.policy } : {}),
        nonce: new asn1js.Integer({ valueHex: new Uint8Array(nonceBytes) }),
        certReq: true,
      });
      const answer = await post({
        url,
        body: new Uint8Array(request.toSchema().toBER(false)),
        headers,
        side: 'TIMESTAMP',
        timeoutMs: config.timeoutMs ?? 15_000,
        maxBytes: MAX_RESPONSE_BYTES,
        fetch: fetchImpl,
      });
      if (answer.status !== 200) throw new SealError('TIMESTAMP_REFUSED', `the timestamping authority answered ${answer.status}`);
      if (!answer.contentType.startsWith('application/timestamp-reply') && !answer.contentType.startsWith('application/timestamp-response')) {
        throw new SealError('TIMESTAMP_REFUSED', 'the timestamping authority did not answer with a timestamp reply');
      }

      const { status, token } = readResponse(answer.body);
      if (status === WAITING) throw new SealError('TIMESTAMP_UNAVAILABLE', 'the timestamping authority asked to be tried again later');
      if (!GRANTED.has(status)) throw new SealError('TIMESTAMP_REFUSED', `the timestamping authority refused, with status ${status}`);
      if (!token) throw new SealError('TIMESTAMP_REFUSED', 'the timestamping authority granted no token');

      const reading = await readTimestampToken(token);
      if (Buffer.compare(Buffer.from(reading.imprint), Buffer.from(digest)) !== 0) throw new SealError('TIMESTAMP_REFUSED', 'the token stamps another digest');
      if (reading.nonce !== nonce) throw new SealError('TIMESTAMP_REFUSED', 'the token answers another request');
      if (config.policy && reading.policy !== config.policy) throw new SealError('TIMESTAMP_REFUSED', 'the token was issued under another policy');
      if (!reading.tsa) throw new SealError('TIMESTAMP_REFUSED', 'the token carries no timestamping authority’s certificate');
      return token;
    },
  };
}

/** TimeStampResp ::= SEQUENCE { status PKIStatusInfo, timeStampToken TimeStampToken OPTIONAL }, the token's bytes as written. */
function readResponse(body: Uint8Array): { status: number; token: Uint8Array | null } {
  const asn = asn1js.fromBER(new Uint8Array(body));
  if (asn.offset === -1 || asn.offset !== body.length || !(asn.result instanceof asn1js.Sequence)) {
    throw new SealError('TIMESTAMP_REFUSED', 'the timestamp reply is not DER');
  }
  const [statusInfo, token] = asn.result.valueBlock.value;
  let status: number;
  try {
    status = new pkijs.PKIStatusInfo({ schema: statusInfo }).status;
  } catch {
    throw new SealError('TIMESTAMP_REFUSED', 'the timestamp reply has no readable status');
  }
  return { status, token: token ? new Uint8Array(token.valueBeforeDecodeView) : null };
}
