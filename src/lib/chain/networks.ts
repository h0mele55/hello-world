import fs from 'node:fs';
import { isIP } from 'node:net';
import path from 'node:path';
import { arbitrum, arbitrumSepolia, base, baseSepolia, foundry, mainnet, optimism, optimismSepolia, sepolia } from 'viem/chains';
import { parseDeployment, type Deployment } from './deployment';
import { ChainError, DeploymentError } from './errors';

/**
 * Server-side only: reads deployment files and RPC URLs. No signing key is
 * read here or anywhere under src/; only scripts/worker.ts holds one.
 *
 * `local` is an Anvil node (chain 31337) at LOCAL_RPC_URL, for rehearsing the
 * deploy script and running the worker by hand.
 *
 * The production candidates (#63, docs/decision-production-chain.md) and the
 * Sepolia testnet of each are named here so that every part of the system
 * (the worker, the verifier, the scripts) handles them the same way. Which one
 * is used is the owner's decision; until it is made, scripts/deploy-registry.ts
 * deploys to the testnets only.
 */

export const NETWORKS = {
  sepolia,
  local: foundry,
  mainnet,
  base,
  'base-sepolia': baseSepolia,
  optimism,
  'optimism-sepolia': optimismSepolia,
  arbitrum,
  'arbitrum-sepolia': arbitrumSepolia,
} as const;
export type NetworkName = keyof typeof NETWORKS;

/**
 * Blocks asked for in one getLogs call when a script reads the registry's
 * events (#142). Public endpoints cap a query's range, and chains differ by an
 * order of magnitude in blocks a month (Arbitrum makes about ten million), so
 * the range is per network, and `<NETWORK>_LOG_RANGE` overrides it for the
 * endpoint in use. A range the endpoint refuses fails the run, never skips.
 */
export const LOG_RANGE_BLOCKS: Record<NetworkName, number> = {
  sepolia: 2_000,
  local: 2_000,
  mainnet: 2_000,
  base: 10_000,
  'base-sepolia': 10_000,
  optimism: 10_000,
  'optimism-sepolia': 10_000,
  arbitrum: 10_000,
  'arbitrum-sepolia': 10_000,
};

export function logRangeFor(network: NetworkName, env: NodeJS.ProcessEnv = process.env): number {
  const name = `${network.toUpperCase().replace(/-/g, '_')}_LOG_RANGE`;
  const raw = env[name];
  if (raw === undefined || raw === '') return LOG_RANGE_BLOCKS[network];
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 1_000_000) throw new ChainError('ENV_INVALID', `${name} must be a whole number of blocks from 1 to 1000000`);
  return value;
}

/** Networks whose anchors would be the firm's real evidence: the candidates measured for the owner (#63). */
export const PRODUCTION_NETWORKS: readonly NetworkName[] = ['mainnet', 'base', 'optimism', 'arbitrum'];

/**
 * The production chain the owner chose on 2026-10-26 (#63,
 * docs/decision-production-chain.md): Arbitrum One. The other candidates stay
 * refused. It is deployed to only after its testnet, whose deployment record
 * must exist first (#123).
 */
export const CHOSEN_PRODUCTION_NETWORK = 'arbitrum' satisfies NetworkName;
export const REHEARSAL_NETWORK: Partial<Record<NetworkName, NetworkName>> = { arbitrum: 'arbitrum-sepolia' };

export function isNetworkName(value: string | undefined): value is NetworkName {
  return value !== undefined && Object.hasOwn(NETWORKS, value);
}

export function deploymentPath(network: string, root = process.cwd()): string {
  return path.join(root, 'deployments', `${network}.json`);
}

export function loadDeployment(network: NetworkName, root = process.cwd()): Deployment {
  return loadDeploymentFile(network, deploymentPath(network, root), root);
}

/** Reads a deployment record from an explicit file, checked like any other. */
export function loadDeploymentFile(network: NetworkName, file: string, root = process.cwd()): Deployment {
  const label = path.relative(root, file);
  if (!fs.existsSync(file)) {
    throw new DeploymentError('DEPLOYMENT_MISSING', `No deployment for ${network}: ${label} does not exist`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new DeploymentError('DEPLOYMENT_INVALID', `${label} is not valid JSON`);
  }
  const deployment = parseDeployment(parsed, label);
  if (deployment.chainId !== NETWORKS[network].id) {
    throw new DeploymentError('DEPLOYMENT_INVALID', `${label} names chain ${deployment.chainId}, not ${network}`);
  }
  return deployment;
}

/** The variable that holds a network's endpoint: SEPOLIA_RPC_URL, BASE_SEPOLIA_RPC_URL, … and LOCAL_RPC_URL. */
export const rpcUrlVariable = (network: NetworkName) => `${network.toUpperCase().replace(/-/g, '_')}_RPC_URL`;

/**
 * The worker's second endpoint (#92): `<NETWORK>_RPC_URL_2`, from another
 * provider than the first, since two endpoints that must agree are worth
 * something only if different parties run them. A local chain may use one
 * (LOCAL_RPC_URL_2, or the first).
 */
/** Second-level labels under which a country code's registrable domains sit (example.co.uk). */
const SECOND_LEVEL = new Set(['ac', 'co', 'com', 'edu', 'gov', 'net', 'org']);

/**
 * Who serves an endpoint, as far as its URL tells (#142): a heuristic, not
 * proof that two providers are independent. The loopback interface, however
 * spelled (127.x, ::1, localhost), is one host, told apart only by port; an IP
 * literal is itself; a host name is its registrable domain, so two host names
 * of one provider (eth-sepolia.g.alchemy.com, arb-sepolia.g.alchemy.com) are
 * one. A path, query or key never makes another provider.
 */
export function providerOf(url: string): string {
  const u = new URL(url);
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  if (host === 'localhost' || host.endsWith('.localhost') || /^127\./.test(host) || host === '::1' || /^(0+:){7}0*1$/.test(host) || host === '::ffff:127.0.0.1') return `loopback:${port}`;
  if (isIP(host)) return host;
  const labels = host.split('.');
  const keep = labels.length >= 3 && labels.at(-1)!.length === 2 && SECOND_LEVEL.has(labels.at(-2)!) ? 3 : 2;
  return labels.slice(-keep).join('.');
}

export function secondRpcUrlFor(network: NetworkName, env: NodeJS.ProcessEnv = process.env): string {
  if (network === 'local') return env.LOCAL_RPC_URL_2 || rpcUrlFor(network, env);
  const name = `${rpcUrlVariable(network)}_2`;
  const url = env[name];
  if (!url) throw new ChainError('ENV_MISSING', `${name} is not set: the worker reads a second endpoint, from another provider (#92)`);
  let providers: string[];
  try {
    providers = [rpcUrlFor(network, env), url].map(providerOf);
  } catch {
    throw new ChainError('ENV_INVALID', `${rpcUrlVariable(network)} or ${name} is not a URL`);
  }
  if (providers[0] === providers[1]) throw new ChainError('RPC_NOT_INDEPENDENT', `${name} must be another provider than ${rpcUrlVariable(network)}`);
  return url;
}

export function rpcUrlFor(network: NetworkName, env: NodeJS.ProcessEnv = process.env): string {
  if (network === 'local') return env.LOCAL_RPC_URL || 'http://127.0.0.1:8545';
  const name = rpcUrlVariable(network);
  const url = env[name];
  if (!url) throw new ChainError('ENV_MISSING', `${name} is not set`);
  return url;
}
