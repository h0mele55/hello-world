import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { p256 } from '@noble/curves/nist';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import type { TestPki } from './test-pki';

/**
 * A trust service provider on the loopback address, for the seal's tests
 * (#70): a CSC API v2 service holding the test PKI's seal key, and an RFC 3161
 * timestamping authority. Each request is recorded, and `behaviour` makes the
 * provider misbehave the ways a real one can.
 */

export interface FakeSealBehaviour {
  /** The credential's authorisation, as `credentials/info` reports it. */
  authMode: 'implicit' | 'explicit' | 'oauth2code';
  /** For `explicit`: whether a PIN is asked for, and whether a one-time password is too. */
  pin?: string;
  otp?: boolean;
  /** Answer ECDSA signatures as r ‖ s rather than DER. */
  rawEcdsa?: boolean;
  /** A status to answer every CSC call with, instead of its reply. */
  cscStatus?: number;
  /** The timestamping authority's PKIStatus; 0 grants. */
  tsaStatus?: number;
  /** An HTTP status to answer every timestamp request with. */
  tsaHttpStatus?: number;
  /** Answer with another nonce than the request's. */
  wrongNonce?: boolean;
}

export interface FakeSealProvider {
  cscUrl: string;
  tokenUrl: string;
  tsaUrl: string;
  clientId: string;
  clientSecret: string;
  credentialId: string;
  behaviour: FakeSealBehaviour;
  requests: { path: string; headers: IncomingMessage['headers']; body: Buffer }[];
  close(): Promise<void>;
}

const read = (req: IncomingMessage) =>
  new Promise<Buffer>((resolve, reject) => {
    const parts: Buffer[] = [];
    req.on('data', (part: Buffer) => parts.push(part));
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });

export async function startFakeSealProvider(pki: TestPki, behaviour: FakeSealBehaviour = { authMode: 'implicit' }): Promise<FakeSealProvider> {
  const clientId = 'seal-client';
  const clientSecret = 'not-a-real-secret';
  const credentialId = 'firm-seal-1';
  const accessToken = 'fake-access-token';
  const sads = new Set<string>();
  const requests: FakeSealProvider['requests'] = [];
  const state: FakeSealProvider = {
    cscUrl: '',
    tokenUrl: '',
    tsaUrl: '',
    clientId,
    clientSecret,
    credentialId,
    behaviour,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };

  const server: Server = createServer(async (req, res) => {
    const body = await read(req);
    const path = req.url ?? '/';
    requests.push({ path, headers: req.headers, body });
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    const b = state.behaviour;

    if (path === '/tsa') {
      if (b.tsaHttpStatus) return void res.writeHead(b.tsaHttpStatus).end();
      const request = new pkijs.TimeStampReq({ schema: asn1js.fromBER(new Uint8Array(body)).result });
      const status = b.tsaStatus ?? 0;
      const token =
        status === 0 || status === 1
          ? await pki.timestamper.token(new Uint8Array(request.messageImprint.hashedMessage.valueBlock.valueHexView), {
              nonce: b.wrongNonce ? new asn1js.Integer({ value: 7 }) : request.nonce,
              policy: request.reqPolicy,
            })
          : null;
      const reply = new asn1js.Sequence({
        value: [new pkijs.PKIStatusInfo({ status }).toSchema(), ...(token ? [asn1js.fromBER(token).result] : [])],
      });
      res.writeHead(200, { 'content-type': 'application/timestamp-reply' });
      return void res.end(Buffer.from(reply.toBER(false)));
    }

    if (b.cscStatus) return json(b.cscStatus, { error: 'invalid_request', error_description: 'refused by the fake provider' });
    if (path === '/oauth2/token') {
      const form = new URLSearchParams(body.toString('utf8'));
      if (form.get('grant_type') !== 'client_credentials' || form.get('client_id') !== clientId || form.get('client_secret') !== clientSecret) return json(401, { error: 'invalid_client' });
      return json(200, { access_token: accessToken, token_type: 'Bearer', expires_in: 3600 });
    }
    if (path === '/csc/v2/auth/login') {
      if (req.headers.authorization !== `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`) return json(401, { error: 'invalid_client' });
      return json(200, { access_token: accessToken, expires_in: 3600 });
    }
    if (req.headers.authorization !== `Bearer ${accessToken}`) return json(401, { error: 'invalid_token' });
    const call = JSON.parse(body.toString('utf8') || '{}') as Record<string, unknown>;
    if (call.credentialID !== credentialId) return json(400, { error: 'invalid_request' });

    if (path === '/csc/v2/credentials/info') {
      const certificates = await pki.signer.certificates();
      const objects = b.authMode === 'explicit' ? [...(b.pin ? [{ type: 'Password', id: 'PIN' }] : []), ...(b.otp ? [{ type: 'OTP', id: 'OTP' }] : [])] : [];
      return json(200, {
        key: { status: 'enabled', algo: ['1.2.840.113549.1.1.11', '1.2.840.10045.4.3.2'], len: 2048 },
        cert: { status: 'valid', certificates: certificates.map((c) => Buffer.from(c).toString('base64')) },
        auth: { mode: b.authMode, objects },
        SCAL: '1',
      });
    }
    if (path === '/csc/v2/credentials/authorize') {
      if (b.authMode === 'oauth2code') return json(400, { error: 'invalid_request' });
      if (b.authMode === 'explicit' && b.pin && call.PIN !== b.pin) return json(400, { error: 'invalid_pin' });
      const sad = `sad-${sads.size + 1}`;
      sads.add(sad);
      return json(200, { SAD: sad, expiresIn: 300 });
    }
    if (path === '/csc/v2/signatures/signHash') {
      if (typeof call.SAD !== 'string' || !sads.delete(call.SAD)) return json(400, { error: 'invalid_request', error_description: 'unknown SAD' });
      const hashes = call.hashes as string[];
      if (call.hashAlgorithmOID !== '2.16.840.1.101.3.4.2.1' || hashes.length !== 1) return json(400, { error: 'invalid_request' });
      let signature = await pki.signer.signDigest(new Uint8Array(Buffer.from(hashes[0], 'base64')));
      if (b.rawEcdsa) signature = p256.Signature.fromDER(signature).toCompactRawBytes();
      return json(200, { signatures: [Buffer.from(signature).toString('base64')] });
    }
    return json(404, { error: 'not_found' });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  state.cscUrl = `http://127.0.0.1:${port}/csc/v2`;
  state.tokenUrl = `http://127.0.0.1:${port}/oauth2/token`;
  state.tsaUrl = `http://127.0.0.1:${port}/tsa`;
  return state;
}
