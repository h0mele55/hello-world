import fs from 'node:fs';
import { getAddress, type Address, type Hex } from 'viem';
import { z } from 'zod';
import { ChainError } from '@/lib/chain/errors';
import { deploymentPath, isNetworkName, loadDeployment, type NetworkName } from '@/lib/chain/networks';
import type { VerifierConfig } from '@/lib/verify-core';

/**
 * What the public verifier is told, from the server's environment and the
 * deployment record. Everything here is sent to every visitor's browser, so
 * nothing here may be a secret: the verifier's RPC endpoints are their own
 * variables, separate from SEPOLIA_RPC_URL, which may carry a private key.
 *
 *   VERIFY_NETWORK      sepolia or local (default: ANCHOR_NETWORK)
 *   VERIFY_RPC_URL_1/2  two independent public endpoints, on different hosts
 *                       (local: both default to LOCAL_RPC_URL)
 */

type Env = Readonly<Record<string, string | undefined>>;

export interface VerifierSetup extends VerifierConfig {
  network: NetworkName;
  /** Lower-case org id -> the name the deployment registered it under. */
  issuers: Record<string, string>;
}

export type VerifierSetupRefusal = 'NOT_CONFIGURED' | 'NETWORK_INVALID' | 'DEPLOYMENT_UNAVAILABLE' | 'RPC_URLS_MISSING' | 'RPC_URLS_INVALID' | 'RPC_URLS_NOT_INDEPENDENT';

export type VerifierSetupResult = { ok: true; setup: VerifierSetup } | { ok: false; reason: VerifierSetupRefusal };

/** The deployment record names the issuer it registered (scripts/deploy-registry.ts). */
const IssuerEntry = z.object({ orgId: z.string().regex(/^0x[0-9a-fA-F]{64}$/), orgName: z.string().trim().min(1).max(200) });

function issuersOf(network: NetworkName, root: string): Record<string, string> {
  try {
    const record = JSON.parse(fs.readFileSync(deploymentPath(network, root), 'utf8')) as { issuer?: unknown };
    const issuer = IssuerEntry.safeParse(record.issuer);
    return issuer.success ? { [issuer.data.orgId.toLowerCase()]: issuer.data.orgName } : {};
  } catch {
    return {};
  }
}

/** The verifier's two endpoints, or why they are refused; no file is read, so the proxy may ask on every request. */
export function verifierRpcUrls(env: Env = process.env): [string, string] | VerifierSetupRefusal {
  const network = env.VERIFY_NETWORK || env.ANCHOR_NETWORK;
  if (!network) return 'NOT_CONFIGURED';
  if (!isNetworkName(network)) return 'NETWORK_INVALID';
  return rpcUrlsOf(network, env);
}

function rpcUrlsOf(network: NetworkName, env: Env): [string, string] | VerifierSetupRefusal {
  const local = env.LOCAL_RPC_URL || 'http://127.0.0.1:8545';
  const raw = network === 'local' ? [env.VERIFY_RPC_URL_1 || local, env.VERIFY_RPC_URL_2 || local] : [env.VERIFY_RPC_URL_1, env.VERIFY_RPC_URL_2];
  if (!raw[0] || !raw[1]) return 'RPC_URLS_MISSING';
  let urls: URL[];
  try {
    urls = raw.map((value) => new URL(value!));
  } catch {
    return 'RPC_URLS_INVALID';
  }
  const schemes = network === 'local' ? ['http:', 'https:'] : ['https:'];
  if (urls.some((url) => !schemes.includes(url.protocol) || url.username || url.password)) return 'RPC_URLS_INVALID';
  // Two endpoints that must agree are worth something only if they are run by different parties.
  if (network !== 'local' && urls[0].hostname === urls[1].hostname) return 'RPC_URLS_NOT_INDEPENDENT';
  return [raw[0], raw[1]];
}

export function verifierSetupFromEnv(env: Env = process.env, root = process.cwd()): VerifierSetupResult {
  const network = env.VERIFY_NETWORK || env.ANCHOR_NETWORK;
  if (!network) return { ok: false, reason: 'NOT_CONFIGURED' };
  if (!isNetworkName(network)) return { ok: false, reason: 'NETWORK_INVALID' };
  let deployment;
  try {
    deployment = loadDeployment(network, root);
  } catch (error) {
    if (error instanceof ChainError) return { ok: false, reason: 'DEPLOYMENT_UNAVAILABLE' };
    throw error;
  }
  const rpcUrls = rpcUrlsOf(network, env);
  if (typeof rpcUrls === 'string') return { ok: false, reason: rpcUrls };
  return {
    ok: true,
    setup: {
      network,
      chainId: deployment.chainId,
      registry: getAddress(deployment.address) as Address,
      runtimeBytecodeHash: deployment.runtimeBytecodeHash as Hex,
      rpcUrls,
      issuers: issuersOf(network, root),
    },
  };
}
