import fs from 'node:fs';
import path from 'node:path';
import { createPublicClient, createWalletClient, http, isHex, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { createChainAdapter, type ChainAdapter } from './adapter';
import { parseDeployment, type Deployment } from './deployment';
import { ChainError, DeploymentError } from './errors';

/** Server-side only: reads deployment files and signing keys. */

export const NETWORKS = { sepolia } as const;
export type NetworkName = keyof typeof NETWORKS;

export function deploymentPath(network: string, root = process.cwd()): string {
  return path.join(root, 'deployments', `${network}.json`);
}

export function loadDeployment(network: NetworkName, root = process.cwd()): Deployment {
  const file = deploymentPath(network, root);
  if (!fs.existsSync(file)) {
    throw new DeploymentError('DEPLOYMENT_MISSING', `No deployment for ${network}: ${path.relative(root, file)} does not exist`);
  }
  const deployment = parseDeployment(JSON.parse(fs.readFileSync(file, 'utf8')), path.relative(root, file));
  if (deployment.chainId !== NETWORKS[network].id) {
    throw new DeploymentError('DEPLOYMENT_INVALID', `${path.relative(root, file)} names chain ${deployment.chainId}, not ${network}`);
  }
  return deployment;
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new ChainError('ENV_MISSING', `${name} is not set`);
  return value;
}

/** The issuer's adapter for Sepolia, from SEPOLIA_RPC_URL and ISSUER_PRIVATE_KEY. */
export function createSepoliaAdapter(env: NodeJS.ProcessEnv = process.env, root = process.cwd()): ChainAdapter {
  const deployment = loadDeployment('sepolia', root);
  const key = requireEnv(env, 'ISSUER_PRIVATE_KEY');
  if (!isHex(key) || key.length !== 66) throw new ChainError('ENV_INVALID', 'ISSUER_PRIVATE_KEY is not a 32-byte hex key');
  const transport = http(requireEnv(env, 'SEPOLIA_RPC_URL'));
  return createChainAdapter({
    publicClient: createPublicClient({ chain: sepolia, transport }) as PublicClient,
    walletClient: createWalletClient({ chain: sepolia, transport, account: privateKeyToAccount(key) }),
    deployment,
  });
}
