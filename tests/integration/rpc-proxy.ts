import http from 'node:http';

/**
 * A JSON-RPC endpoint on a port of its own that forwards to another: a second
 * endpoint for a test where one node must stand in for two providers (#142),
 * or, with `refuse`, an endpoint that fails the calls it names.
 */
export async function startRpcProxy(target: string, options: { refuse?: (method: string) => boolean } = {}): Promise<{ url: string; close(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk));
    req.on('end', async () => {
      try {
        const call = JSON.parse(body) as { method?: string };
        if (call.method && options.refuse?.(call.method)) {
          res.writeHead(503).end();
          return;
        }
        const upstream = await fetch(target, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
        res.writeHead(upstream.status, { 'content-type': 'application/json' }).end(await upstream.text());
      } catch {
        res.writeHead(502).end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
