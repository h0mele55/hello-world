import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';

export interface AnvilHandle {
  url: string;
  stop(): Promise<void>;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

/**
 * Starts a throwaway Anvil chain. `--slots-in-an-epoch 1` makes `finalized`
 * trail `latest` by two blocks, so a test reaches finality by mining a few.
 * Fails loudly if Foundry is not installed rather than skipping: a skipped
 * integration test reads as a passing one.
 */
export async function startAnvil(): Promise<AnvilHandle> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const child: ChildProcess = spawn('anvil', ['--port', String(port), '--chain-id', '31337', '--slots-in-an-epoch', '1', '--silent'], {
    stdio: 'ignore',
  });
  const spawnError = new Promise<never>((_, reject) =>
    child.once('error', (e) => reject(new Error(`Could not start anvil (install Foundry): ${e.message}`))),
  );

  const ready = (async () => {
    for (let i = 0; i < 100; i++) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
        });
        if (res.ok) return;
      } catch {
        // not listening yet
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('anvil did not start within 10 seconds');
  })();

  await Promise.race([ready, spawnError]);
  return {
    url,
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
      }),
  };
}
