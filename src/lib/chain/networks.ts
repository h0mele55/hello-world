import fs from 'node:fs';
import path from 'node:path';
import { foundry, sepolia } from 'viem/chains';
import { parseDeployment, type Deployment } from './deployment';
import { ChainError, DeploymentError } from './errors';

/**
 * Server-side only: reads deployment files and RPC URLs. No signing key is
 * read here or anywhere under src/; only scripts/worker.ts holds one.
 *
 * `local` is an Anvil node (chain 31337) at LOCAL_RPC_URL, for rehearsing the
 * deploy script and running the worker by hand.
 */

export const NETWORKS = { sepolia, local: foundry } as const;
export type NetworkName = keyof typeof NETWORKS;

export function isNetworkName(value: string | undefined): value is NetworkName {
  return value !== undefined && Object.hasOwn(NETWORKS, value);
}

export function deploymentPath(network: string, root = process.cwd()): string {
  return path.join(root, 'deployments', `${network}.json`);
}

export function loadDeployment(network: NetworkName, root = process.cwd()): Deployment {
  const file = deploymentPath(network, root);
  if (!fs.existsSync(file)) {
    throw new DeploymentError('DEPLOYMENT_MISSING', `No deployment for ${network}: ${path.relative(root, file)} does not exist`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new DeploymentError('DEPLOYMENT_INVALID', `${path.relative(root, file)} is not valid JSON`);
  }
  const deployment = parseDeployment(parsed, path.relative(root, file));
  if (deployment.chainId !== NETWORKS[network].id) {
    throw new DeploymentError('DEPLOYMENT_INVALID', `${path.relative(root, file)} names chain ${deployment.chainId}, not ${network}`);
  }
  return deployment;
}

export function rpcUrlFor(network: NetworkName, env: NodeJS.ProcessEnv = process.env): string {
  const url = network === 'sepolia' ? env.SEPOLIA_RPC_URL : (env.LOCAL_RPC_URL || 'http://127.0.0.1:8545');
  if (!url) throw new ChainError('ENV_MISSING', 'SEPOLIA_RPC_URL is not set');
  return url;
}
