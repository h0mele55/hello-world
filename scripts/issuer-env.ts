/**
 * What the worker and the operator tools need to act as the issuer, read from
 * the environment only (never a file in the repository):
 *
 *   DATABASE_URL        the app's database
 *   ANCHOR_NETWORK      sepolia or local; deployments/<network>.json names the registry
 *   DEPLOYMENT_FILE     optional; a deployment record other than that file
 *   ISSUER_PRIVATE_KEY  the issuer key. Read by scripts only: the web app never holds it.
 *   ISSUER_ADDRESS      optional; when set, must be the key's address (it is what the web app journals)
 *   SEPOLIA_RPC_URL / LOCAL_RPC_URL
 *
 * Run from the app's directory: the PDF parser and deployments/ are found from there.
 */
import path from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { createPublicClient, getAddress, http, isHex, type LocalAccount, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { PrismaClient } from '../src/generated/prisma/client';
import type { Deployment } from '../src/lib/chain/deployment';
import { isNetworkName, loadDeployment, loadDeploymentFile, NETWORKS, rpcUrlFor, type NetworkName } from '../src/lib/chain/networks';

export function refuse(tool: string, message: string): never {
  console.error(JSON.stringify({ level: 'error', message: `${tool} refused to start: ${message}` }));
  process.exit(1);
}

export function requireEnv(tool: string, name: string): string {
  const value = process.env[name];
  if (!value) refuse(tool, `${name} is not set`);
  return value;
}

export interface IssuerEnv {
  network: NetworkName;
  account: LocalAccount;
  deployment: Deployment;
  publicClient: PublicClient;
  prisma: PrismaClient;
  /** A dedicated session for the issuer's advisory lock. */
  lockClient: pg.Client;
  close(): Promise<void>;
}

export async function issuerEnv(tool: string): Promise<IssuerEnv> {
  const network = requireEnv(tool, 'ANCHOR_NETWORK');
  if (!isNetworkName(network)) refuse(tool, 'ANCHOR_NETWORK must be sepolia or local');
  const key = requireEnv(tool, 'ISSUER_PRIVATE_KEY');
  if (!isHex(key) || key.length !== 66) refuse(tool, 'ISSUER_PRIVATE_KEY is not a 32-byte hex key');
  const account = privateKeyToAccount(key);
  const declared = process.env.ISSUER_ADDRESS;
  if (declared && getAddress(declared) !== account.address) refuse(tool, 'ISSUER_ADDRESS is not the address of ISSUER_PRIVATE_KEY');

  const deployment = process.env.DEPLOYMENT_FILE ? loadDeploymentFile(network, path.resolve(process.env.DEPLOYMENT_FILE)) : loadDeployment(network);
  const publicClient = createPublicClient({ chain: NETWORKS[network], transport: http(rpcUrlFor(network)) }) as PublicClient;
  const databaseUrl = requireEnv(tool, 'DATABASE_URL');
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl, max: 4, connectionTimeoutMillis: 10_000 }) });
  const lockClient = new pg.Client({ connectionString: databaseUrl });
  await lockClient.connect();
  return {
    network,
    account,
    deployment,
    publicClient,
    prisma,
    lockClient,
    async close() {
      await lockClient.end();
      await prisma.$disconnect();
    },
  };
}
