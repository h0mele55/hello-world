import fs from 'node:fs';
import { getAddress, type Address, type Hex } from 'viem';
import { z } from 'zod';
import { ChainError } from '@/lib/chain/errors';
import { deploymentPath, isNetworkName, loadDeployment, type NetworkName } from '@/lib/chain/networks';
import type { VerifierConfig } from '@/lib/verify-core';
import { pemCertificates } from '@/lib/eseal/pem';

/**
 * What the public verifier is told, from the server's environment and the
 * deployment record. Everything here is sent to every visitor's browser, so
 * nothing here may be a secret: the verifier's RPC endpoints are their own
 * variables, separate from SEPOLIA_RPC_URL, which may carry a private key.
 *
 *   VERIFY_NETWORK      a network in NETWORKS, e.g. sepolia or local (default: ANCHOR_NETWORK)
 *   VERIFY_RPC_URL_1/2  two independent public endpoints, on different hosts
 *                       (local: both default to LOCAL_RPC_URL)
 *   SEAL_TRUST_ANCHORS  optional; the PEM file of roots the firm's electronic seal
 *                       chains to (#70), the worker's own: public certificates, so
 *                       a verifier can check a matched copy's seal (#120)
 *   REANCHOR_ARCHIVES   optional; comma-separated re-anchor archives or proofs of
 *                       retired registries (#65), whose roots are recorded on this
 *                       one. Public chain data: /reanchor/<n> serves the n-th, and
 *                       the page fetches them only for a file this registry holds
 *                       no record of (#126). Their paths are never sent.
 */

type Env = Readonly<Record<string, string | undefined>>;

export interface VerifierSetup extends VerifierConfig {
  network: NetworkName;
  /** Lower-case org id -> the name the deployment registered it under. */
  issuers: Record<string, string>;
  /** The roots a copy's seal is checked against, as base64 DER; none when the firm publishes none. */
  sealRoots: string[];
  /** How many re-anchor archives /reanchor/<n> serves (#126); none when the firm has retired no registry. */
  reanchorArchives: number;
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

/** The seal's roots, as base64 DER. A file that cannot be read gives none: the seal then says it cannot be checked, and the verdict is unaffected. */
export function sealRootsOf(file: string | undefined): string[] {
  if (!file) return [];
  try {
    return pemCertificates(fs.readFileSync(file, 'utf8')).map((der) => btoa(String.fromCharCode(...der)));
  } catch {
    return [];
  }
}

/** The re-anchor archives' files, in the order /reanchor/<n> serves them. */
export function reanchorArchivesOf(env: Env = process.env): string[] {
  return (env.REANCHOR_ARCHIVES ?? '')
    .split(',')
    .map((file) => file.trim())
    .filter(Boolean);
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
      sealRoots: sealRootsOf(env.SEAL_TRUST_ANCHORS),
      reanchorArchives: reanchorArchivesOf(env).length,
    },
  };
}
