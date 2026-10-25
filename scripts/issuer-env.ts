/**
 * What the worker and the operator tools need to act as the issuer, read from
 * the environment only (never a file in the repository):
 *
 *   DATABASE_URL        the app's database
 *   ANCHOR_NETWORK      a network in src/lib/chain/networks.ts; deployments/<network>.json names the registry
 *   DEPLOYMENT_FILE     optional; a deployment record other than that file
 *   SIGNER              env (default) or kms
 *   ISSUER_PRIVATE_KEY  with SIGNER=env: the issuer key. Read by scripts only: the web app never holds it.
 *   KMS_KEY_NAME        with SIGNER=kms: the Cloud KMS key version that signs
 *                       (projects/…/cryptoKeyVersions/N); credentials are the
 *                       host's (Application Default Credentials). The key never
 *                       leaves KMS (docs/runbooks/kms-key.md).
 *   ISSUER_ADDRESS      optional; when set, must be the key's address (it is what the web app journals)
 *   <NETWORK>_RPC_URL   e.g. SEPOLIA_RPC_URL, BASE_SEPOLIA_RPC_URL, LOCAL_RPC_URL
 *   <NETWORK>_RPC_URL_2 the worker's second endpoint, from another provider (#92); a local chain may omit it
 *
 * Run from the app's directory: the PDF parser and deployments/ are found from there.
 */
import path from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { createPublicClient, getAddress, http, isHex, type LocalAccount, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ChainError } from '../src/lib/chain/errors';
import { createKmsAccount, KmsSignerError } from '../src/lib/chain/kms-account';
import { PrismaClient } from '../src/generated/prisma/client';
import type { Deployment } from '../src/lib/chain/deployment';
import { isNetworkName, loadDeployment, loadDeploymentFile, NETWORKS, rpcUrlFor, secondRpcUrlFor, type NetworkName } from '../src/lib/chain/networks';

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
  if (!isNetworkName(network)) refuse(tool, `ANCHOR_NETWORK must be one of ${Object.keys(NETWORKS).join(', ')}`);
  const account = await issuerAccount(tool);
  const declared = process.env.ISSUER_ADDRESS;
  if (declared && getAddress(declared) !== account.address) refuse(tool, 'ISSUER_ADDRESS is not the address of the issuer key');

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

/**
 * The worker's second endpoint (#92): every read that settles a row must agree
 * on both. A refusal names the variable; never the URL, which may carry a key.
 */
export function secondPublicClient(tool: string, network: NetworkName): PublicClient {
  try {
    return createPublicClient({ chain: NETWORKS[network], transport: http(secondRpcUrlFor(network)) }) as PublicClient;
  } catch (error) {
    if (error instanceof ChainError) refuse(tool, `${error.code}: ${error.message}`);
    throw error;
  }
}

/** The account that signs as the issuer: a raw key from the environment, or a Cloud KMS key version. */
async function issuerAccount(tool: string): Promise<LocalAccount> {
  const signer = process.env.SIGNER || 'env';
  if (signer === 'env') {
    const key = requireEnv(tool, 'ISSUER_PRIVATE_KEY');
    if (!isHex(key) || key.length !== 66) refuse(tool, 'ISSUER_PRIVATE_KEY is not a 32-byte hex key');
    return privateKeyToAccount(key);
  }
  if (signer !== 'kms') refuse(tool, 'SIGNER must be env or kms');
  // A raw key left beside a KMS key is a copy of a secret nobody uses: refuse it rather than ignore it.
  if (process.env.ISSUER_PRIVATE_KEY) refuse(tool, 'ISSUER_PRIVATE_KEY is set, but SIGNER=kms signs with KMS: remove it');
  const keyName = requireEnv(tool, 'KMS_KEY_NAME');
  const { KeyManagementServiceClient } = await import('@google-cloud/kms');
  try {
    return await createKmsAccount({ client: new KeyManagementServiceClient(), keyName });
  } catch (error) {
    if (error instanceof KmsSignerError) refuse(tool, `${error.code}: ${error.message}`);
    // The name only: a client error can carry request details.
    refuse(tool, `KMS could not be reached (${error instanceof Error ? error.name : typeof error})`);
  }
}
