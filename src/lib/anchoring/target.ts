import { getAddress, isAddress, type Address } from 'viem';
import { ChainError } from '@/lib/chain/errors';
import { isNetworkName, loadDeployment, NETWORKS, type NetworkName } from '@/lib/chain/networks';

/**
 * Where approved anchors go: the network, its registry deployment and the
 * issuer key's address. The web app needs only the address; the key itself is
 * read by scripts/worker.ts alone.
 */
export interface AnchorTarget {
  network: NetworkName;
  chainId: number;
  registry: Address;
  issuer: Address;
}

/**
 * From ANCHOR_NETWORK (a name in NETWORKS: sepolia, local, base-sepolia, …) and ISSUER_ADDRESS. Null when
 * ANCHOR_NETWORK is unset: anchoring is simply not configured. A value that is
 * set but wrong, or a missing or stale deployment file, throws a ChainError.
 */
export function anchorTargetFromEnv(env: NodeJS.ProcessEnv = process.env, root = process.cwd()): AnchorTarget | null {
  const network = env.ANCHOR_NETWORK;
  if (!network) return null;
  if (!isNetworkName(network)) throw new ChainError('ENV_INVALID', `ANCHOR_NETWORK must be one of ${Object.keys(NETWORKS).join(', ')}`);
  const issuer = env.ISSUER_ADDRESS;
  if (!issuer || !isAddress(issuer)) throw new ChainError('ENV_INVALID', 'ISSUER_ADDRESS is not an address');
  const deployment = loadDeployment(network, root);
  return { network, chainId: deployment.chainId, registry: getAddress(deployment.address), issuer: getAddress(issuer) };
}
