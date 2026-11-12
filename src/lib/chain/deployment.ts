import { isAddress, isHex, type Address, type Hex } from 'viem';
import { DeploymentError } from './errors';
import { registryRuntimeBytecodeHash } from './registry-artifact';

/** What deployments/<network>.json records about one registry deployment. */
export interface Deployment {
  chainId: number;
  address: Address;
  /** keccak256 of the runtime bytecode the deployment produced. */
  runtimeBytecodeHash: Hex;
  deployTxHash?: Hex;
  deployBlock?: number;
}

/**
 * Validates a parsed deployment file. Refuses one whose bytecode hash is not
 * this build's: the ABI the code would use would not be the deployed one's.
 */
export function parseDeployment(value: unknown, source: string): Deployment {
  const d = value as Partial<Deployment> | null;
  const valid =
    d !== null &&
    typeof d === 'object' &&
    Number.isInteger(d.chainId) &&
    typeof d.address === 'string' &&
    isAddress(d.address) &&
    typeof d.runtimeBytecodeHash === 'string' &&
    isHex(d.runtimeBytecodeHash) &&
    d.runtimeBytecodeHash.length === 66;
  if (!valid) throw new DeploymentError('DEPLOYMENT_INVALID', `${source} is not a valid deployment record`);
  // Deployed, but its issuer not yet registered (#142): finish it with the deploy script before anything uses it.
  if ((d as { issuer?: { pending?: unknown } }).issuer?.pending === true) {
    throw new DeploymentError('DEPLOYMENT_PENDING', `${source} records a registry whose issuer is not registered yet; run the deploy script again to finish it`);
  }
  if (d.runtimeBytecodeHash !== registryRuntimeBytecodeHash) {
    throw new DeploymentError(
      'DEPLOYMENT_STALE',
      `${source} describes a different AuditReportRegistry build than this code; redeploy or check out the matching commit`,
    );
  }
  return d as Deployment;
}
