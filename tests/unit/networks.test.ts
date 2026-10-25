import { describe, expect, it } from 'vitest';
import { explorerTxUrl, networkNameOf } from '@/lib/chain/explorer';
import { NETWORKS, PRODUCTION_NETWORKS, rpcUrlFor, rpcUrlVariable, secondRpcUrlFor, type NetworkName } from '@/lib/chain/networks';

/**
 * The networks every part of the system knows (#63): one table, so the worker,
 * the verifier and the scripts name, reach and link to a chain the same way.
 */

const names = Object.keys(NETWORKS) as NetworkName[];
const env = (vars: Record<string, string> = {}) => vars as unknown as NodeJS.ProcessEnv;

describe('the networks', () => {
  it('give each name its own chain', () => {
    expect(new Set(names.map((n) => NETWORKS[n].id)).size).toBe(names.length);
    expect(Object.fromEntries(names.map((n) => [n, NETWORKS[n].id]))).toEqual({
      sepolia: 11155111,
      local: 31337,
      mainnet: 1,
      base: 8453,
      'base-sepolia': 84532,
      optimism: 10,
      'optimism-sepolia': 11155420,
      arbitrum: 42161,
      'arbitrum-sepolia': 421614,
    });
  });

  it('hold the production candidates apart, each with a Sepolia testnet to rehearse on', () => {
    expect([...PRODUCTION_NETWORKS].sort()).toEqual(['arbitrum', 'base', 'mainnet', 'optimism']);
    for (const network of PRODUCTION_NETWORKS) {
      const testnet = network === 'mainnet' ? 'sepolia' : `${network}-sepolia`;
      expect(names).toContain(testnet);
      expect(PRODUCTION_NETWORKS).not.toContain(testnet);
    }
  });

  it('read each endpoint from a variable named after the network, and refuse a missing one by that name', () => {
    expect(rpcUrlVariable('base-sepolia')).toBe('BASE_SEPOLIA_RPC_URL');
    expect(rpcUrlFor('base-sepolia', env({ BASE_SEPOLIA_RPC_URL: 'https://b.example' }))).toBe('https://b.example');
    expect(() => rpcUrlFor('arbitrum-sepolia', env())).toThrow('ARBITRUM_SEPOLIA_RPC_URL is not set');
    expect(rpcUrlFor('local', env())).toBe('http://127.0.0.1:8545');
  });

  it('read the worker’s second endpoint, refusing a missing one, a malformed one, and one from the same provider (#92)', () => {
    const first = { SEPOLIA_RPC_URL: 'https://ethereum-sepolia-rpc.publicnode.com' };
    expect(secondRpcUrlFor('sepolia', env({ ...first, SEPOLIA_RPC_URL_2: 'https://sepolia.drpc.org' }))).toBe('https://sepolia.drpc.org');
    expect(() => secondRpcUrlFor('sepolia', env(first))).toThrow(expect.objectContaining({ code: 'ENV_MISSING', message: expect.stringContaining('SEPOLIA_RPC_URL_2 is not set') }));
    expect(() => secondRpcUrlFor('sepolia', env({ ...first, SEPOLIA_RPC_URL_2: 'not a url' }))).toThrow(expect.objectContaining({ code: 'ENV_INVALID' }));
    // Another path or key on the same host is the same provider.
    expect(() => secondRpcUrlFor('sepolia', env({ ...first, SEPOLIA_RPC_URL_2: 'https://ethereum-sepolia-rpc.publicnode.com/?key=2' }))).toThrow(
      expect.objectContaining({ code: 'RPC_NOT_INDEPENDENT' }),
    );
    // A refusal never repeats a URL, which may carry a key.
    expect(() => secondRpcUrlFor('sepolia', env({ SEPOLIA_RPC_URL: 'https://a.example/k3y', SEPOLIA_RPC_URL_2: 'https://a.example/s3cret' }))).toThrow(
      expect.objectContaining({ code: 'RPC_NOT_INDEPENDENT', message: expect.not.stringMatching(/k3y|s3cret|a\.example/) }),
    );
    expect(secondRpcUrlFor('local', env())).toBe('http://127.0.0.1:8545');
    expect(secondRpcUrlFor('local', env({ LOCAL_RPC_URL_2: 'http://127.0.0.1:8546' }))).toBe('http://127.0.0.1:8546');
  });

  it('link every public chain to an explorer and name it for a reader; a local chain gets no link', () => {
    for (const network of names.filter((n) => n !== 'local')) {
      expect(explorerTxUrl(NETWORKS[network].id, '0xabc'), network).toMatch(/^https:\/\/[a-z.-]+\/tx\/0xabc$/);
      expect(networkNameOf(NETWORKS[network].id), network).not.toMatch(/^Chain /);
    }
    expect(explorerTxUrl(31337, '0xabc')).toBeNull();
  });
});
