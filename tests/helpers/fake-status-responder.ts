import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { TestPki } from './test-pki';

/**
 * The status side of the test PKI on the loopback address (#119): POST /ocsp
 * answers OCSP requests and GET /crl/<ca>.crl serves CRLs, from the PKI the
 * responder is handed once its certificates name these URLs. `httpStatus`
 * makes every answer an HTTP error instead, as an outage does.
 */

export interface FakeStatusResponder {
  ocspUrl: string;
  crlUrl: string;
  serve(pki: TestPki): void;
  httpStatus: number | null;
  requests: { method: string; path: string }[];
  close(): Promise<void>;
}

const read = (req: IncomingMessage) =>
  new Promise<Buffer>((resolve, reject) => {
    const parts: Buffer[] = [];
    req.on('data', (part: Buffer) => parts.push(part));
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });

export async function startFakeStatusResponder(): Promise<FakeStatusResponder> {
  let pki: TestPki | null = null;
  const state: FakeStatusResponder = {
    ocspUrl: '',
    crlUrl: '',
    serve: (served) => {
      pki = served;
    },
    httpStatus: null,
    requests: [],
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
  const server: Server = createServer(async (req, res) => {
    const body = await read(req);
    const path = req.url ?? '/';
    state.requests.push({ method: req.method ?? '', path });
    if (state.httpStatus) return void res.writeHead(state.httpStatus).end();
    if (!pki) return void res.writeHead(503).end();
    if (req.method === 'POST' && path === '/ocsp') {
      res.writeHead(200, { 'content-type': 'application/ocsp-response' });
      return void res.end(Buffer.from(await pki.status.ocsp(new Uint8Array(body))));
    }
    const crl = /^\/crl\/([a-z]+)\.crl$/.exec(path);
    const der = req.method === 'GET' && crl ? await pki.status.crl(crl[1]) : null;
    if (!der) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'application/pkix-crl' });
    res.end(Buffer.from(der));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  state.ocspUrl = `http://127.0.0.1:${port}/ocsp`;
  state.crlUrl = `http://127.0.0.1:${port}/crl`;
  return state;
}
