import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createPublicClient, createTestClient, createWalletClient, getAddress, http, keccak256, parseEther, toBytes, type Hex, type PublicClient } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createChainAdapter } from '@/lib/chain/adapter';
import { loadDeploymentFile, NETWORKS } from '@/lib/chain/networks';
import { registryAbi } from '@/lib/chain/registry-artifact';
import { ZERO_HASH } from '@/lib/chain/records';
import { startAnvil, type AnvilHandle } from './anvil';
import { startRpcProxy } from './rpc-proxy';

/**
 * A production candidate's testnet end to end (#63): the deploy script deploys
 * to Base Sepolia (an Anvil node with its chain id stands in for it), refuses a
 * production network outright, and the adapter anchors through viem's OP Stack
 * chain definition and reaches finality.
 */

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const run = promisify(execFile);
const h = (label: string): Hex => keccak256(toBytes(label));
let anvil: AnvilHandle;
let dir: string;

beforeAll(async () => {
  anvil = await startAnvil({ chainId: NETWORKS['base-sepolia'].id });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'networks-'));
}, 60_000);

afterAll(async () => {
  await anvil?.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function deploy(network: string, env: Record<string, string>) {
  return run(path.join(ROOT, 'node_modules', '.bin', 'tsx'), ['scripts/deploy-registry.ts', network], {
    cwd: ROOT,
    env: { PATH: process.env.PATH, ...env } as unknown as NodeJS.ProcessEnv,
  }).then(
    (r) => ({ code: 0, out: r.stdout, err: r.stderr }),
    (e: { code: number; stdout: string; stderr: string }) => ({ code: e.code, out: e.stdout, err: e.stderr }),
  );
}

describe('deploying to a production candidate’s testnet', () => {
  it('refuses a production network the owner did not choose, and the chosen one until its testnet is deployed (#63)', async () => {
    const keys = { DEPLOYER_PRIVATE_KEY: generatePrivateKey(), ISSUER_ADDRESS: privateKeyToAccount(generatePrivateKey()).address, ISSUER_ORG_NAME: 'Firm' };
    const refused = await deploy('base', { BASE_RPC_URL: anvil.url, ...keys });
    expect(refused).toMatchObject({ code: 1, err: expect.stringContaining('production network the owner did not choose') });
    // Arbitrum One is the owner's choice, and waits on deployments/arbitrum-sepolia.json, which no test writes.
    const notYet = await deploy('arbitrum', { ARBITRUM_RPC_URL: anvil.url, ...keys });
    expect(notYet).toMatchObject({ code: 1, err: expect.stringContaining('deployments/arbitrum-sepolia.json does not exist yet') });
  });

  it('deploys to Base Sepolia, and the adapter anchors there and reaches finality', async () => {
    const transport = http(anvil.url);
    const testClient = createTestClient({ chain: NETWORKS['base-sepolia'], mode: 'anvil', transport });
    const deployerKey = generatePrivateKey();
    const issuerKey = generatePrivateKey();
    const issuer = privateKeyToAccount(issuerKey);
    await testClient.setBalance({ address: privateKeyToAccount(deployerKey).address, value: parseEther('0.05') });
    await testClient.setBalance({ address: issuer.address, value: parseEther('1') });

    const file = path.join(dir, 'base-sepolia.json');
    const deployed = await deploy('base-sepolia', { BASE_SEPOLIA_RPC_URL: anvil.url, DEPLOYER_PRIVATE_KEY: deployerKey, ISSUER_ADDRESS: issuer.address, ISSUER_ORG_NAME: 'Firm', DEPLOYMENT_FILE: file });
    expect(deployed.code).toBe(0);
    expect(deployed.out).toContain('ETHERSCAN_API_KEY is not set');
    expect(deployed.out).toContain(`--chain ${NETWORKS['base-sepolia'].id}`);
    const deployment = loadDeploymentFile('base-sepolia', file);
    expect(deployment.chainId).toBe(84532);
    expect(() => loadDeploymentFile('sepolia', file)).toThrow('not sepolia');

    // Off a local chain a revocation waits a day by default (#95), and the record says so.
    const publicClient = createPublicClient({ chain: NETWORKS['base-sepolia'], transport, pollingInterval: 50 }) as PublicClient;
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ revocationDelaySeconds: 86_400 });
    expect(await publicClient.readContract({ address: deployment.address, abi: registryAbi, functionName: 'revocationDelay' })).toBe(86_400);
    // The source verification command carries the delay among the constructor arguments.
    expect(deployed.out).toContain('0000000000000000000000000000000000000000000000000000000000015180');

    const adapter = createChainAdapter({ publicClient, walletClient: createWalletClient({ chain: NETWORKS['base-sepolia'], transport, account: issuer }), deployment });
    const sent = await adapter.anchor({ familyId: h('f'), version: 1, parentId: ZERO_HASH, docHash: h('d'), manifestHash: h('m'), opinionCommitment: h('o') });
    await testClient.mine({ blocks: 3 });
    await adapter.waitFinal(sent.txHash, { pollMs: 20, timeoutMs: 5_000 });
    expect(await adapter.findByDocHash(h('d'))).toMatchObject({ recordId: sent.recordId, issuer: getAddress(issuer.address) });
  });

  it('records the registry before registering its issuer, and a second run finishes it rather than deploying another (#142)', async () => {
    const transport = http(anvil.url);
    const testClient = createTestClient({ chain: NETWORKS['base-sepolia'], mode: 'anvil', transport });
    const deployerKey = generatePrivateKey();
    await testClient.setBalance({ address: privateKeyToAccount(deployerKey).address, value: parseEther('0.05') });
    const issuer = privateKeyToAccount(generatePrivateKey()).address;
    // An endpoint that takes the deployment and then drops: the issuer's registration never leaves.
    let sends = 0;
    const flaky = await startRpcProxy(anvil.url, { refuse: (method) => method === 'eth_sendRawTransaction' && ++sends > 1 });
    const flakyUrl = flaky.url;
    const file = path.join(dir, 'resumed.json');
    const env = { DEPLOYER_PRIVATE_KEY: deployerKey, ISSUER_ADDRESS: issuer, ISSUER_ORG_NAME: 'Firm', DEPLOYMENT_FILE: file };
    try {
      const failed = await deploy('base-sepolia', { ...env, BASE_SEPOLIA_RPC_URL: flakyUrl });
      expect(failed.code).toBe(1);
    } finally {
      await flaky.close();
    }
    // The registry is on chain and recorded, its issuer pending; nothing will use it yet.
    const pending = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(pending).toMatchObject({ issuer: { address: issuer, orgName: 'Firm', pending: true } });
    expect(() => loadDeploymentFile('base-sepolia', file)).toThrow(expect.objectContaining({ code: 'DEPLOYMENT_PENDING' }));

    // Another issuer is refused; the same settings finish the same registry.
    const other = await deploy('base-sepolia', { ...env, BASE_SEPOLIA_RPC_URL: anvil.url, ISSUER_ADDRESS: privateKeyToAccount(generatePrivateKey()).address });
    expect(other).toMatchObject({ code: 1, err: expect.stringContaining('resume it with the same ISSUER_ADDRESS') });
    const resumed = await deploy('base-sepolia', { ...env, BASE_SEPOLIA_RPC_URL: anvil.url });
    expect(resumed).toMatchObject({ code: 0, out: expect.stringContaining(`Resuming the registry at ${pending.address}`) });
    const done = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(done).toMatchObject({ address: pending.address, deployTxHash: pending.deployTxHash, issuer: { address: issuer, setIssuerTxHash: expect.stringMatching(/^0x/) } });
    expect(done.issuer.pending).toBeUndefined();
    const publicClient = createPublicClient({ chain: NETWORKS['base-sepolia'], transport }) as PublicClient;
    expect(await publicClient.readContract({ address: pending.address, abi: registryAbi, functionName: 'issuers', args: [issuer] })).toEqual([keccak256(toBytes('Firm')), true]);
    // Complete, it is never deployed over.
    expect(await deploy('base-sepolia', { ...env, BASE_SEPOLIA_RPC_URL: anvil.url })).toMatchObject({ code: 1, err: expect.stringContaining('already exists') });
  });

  it('refuses a revocation delay under an hour off a local chain, or over the contract\'s 30 days, before deploying', async () => {
    const env = (hours: string) => ({
      BASE_SEPOLIA_RPC_URL: anvil.url,
      DEPLOYER_PRIVATE_KEY: generatePrivateKey(),
      ISSUER_ADDRESS: privateKeyToAccount(generatePrivateKey()).address,
      ISSUER_ORG_NAME: 'Firm',
      DEPLOYMENT_FILE: path.join(dir, `delay-${hours}.json`),
      REVOCATION_DELAY_HOURS: hours,
    });
    for (const [hours, reason] of [['0', 'at least 1'], ['721', 'at most 720'], ['1.5', 'whole number'], ['-2', 'whole number']]) {
      const refused = await deploy('base-sepolia', env(hours));
      expect(refused, hours).toMatchObject({ code: 1, err: expect.stringContaining(reason) });
      expect(fs.existsSync(path.join(dir, `delay-${hours}.json`))).toBe(false);
    }
  });
});
