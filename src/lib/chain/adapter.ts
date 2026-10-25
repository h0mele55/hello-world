import { BaseError, ContractFunctionRevertedError, type Hash, type Hex, type PublicClient, type WalletClient } from 'viem';
import type { Deployment } from './deployment';
import { ChainError, RegistryRevertError } from './errors';
import { recordIdFor, ZERO_HASH } from './records';
import { createRegistryReader, type RegistryReader } from './reader';
import { registryAbi } from './registry-artifact';

export interface AnchorInput {
  familyId: Hex;
  version: number;
  /** The family's current latest for version 2 and up; zero for version 1. */
  parentId: Hex;
  docHash: Hex;
  manifestHash: Hex;
  opinionCommitment: Hex;
}

/**
 * A broadcast transaction and the record it will create. Not an anchor: the
 * caller must journal it and wait for `waitFinal` (rules 2 and 3).
 */
export interface SentWrite {
  txHash: Hash;
  recordId: Hex;
}

export interface ChainAdapter extends RegistryReader {
  anchor(input: AnchorInput): Promise<SentWrite>;
  anchorCopy(originalId: Hex, docHash: Hex): Promise<SentWrite>;
  revoke(recordId: Hex, reasonCode: number): Promise<SentWrite>;
}

/** Turns a contract revert into a RegistryRevertError named after the contract's custom error. */
export function toRegistryError(error: unknown): unknown {
  if (error instanceof ChainError) return error;
  if (error instanceof BaseError) {
    const revert = error.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError && revert.data?.errorName) {
      return new RegistryRevertError(revert.data.errorName, revert.data.args ?? []);
    }
  }
  return error;
}

/**
 * The only code that writes to the registry. Server-side: the wallet client
 * holds the issuer key. Every write first checks the chain id and the deployed
 * bytecode, then simulates, so a refusal arrives as a named error before
 * anything is broadcast.
 */
export function createChainAdapter(options: {
  publicClient: PublicClient;
  walletClient: WalletClient;
  deployment: Deployment;
}): ChainAdapter {
  const { publicClient, walletClient, deployment } = options;
  const reader = createRegistryReader(publicClient, deployment);
  const account = walletClient.account;
  if (!account) throw new ChainError('NO_ACCOUNT', 'The wallet client has no account to sign with');

  async function send(
    functionName: 'anchor' | 'anchorDistributionCopy' | 'revoke',
    args: readonly unknown[],
    recordId: Hex,
  ): Promise<SentWrite> {
    await reader.assertDeployment();
    try {
      const { request } = await publicClient.simulateContract({
        address: deployment.address,
        abi: registryAbi,
        functionName,
        args,
        account,
      } as Parameters<typeof publicClient.simulateContract>[0]);
      const txHash = await walletClient.writeContract(request as Parameters<typeof walletClient.writeContract>[0]);
      return { txHash, recordId };
    } catch (error) {
      throw toRegistryError(error);
    }
  }

  return {
    ...reader,
    anchor(input) {
      const recordId = recordIdFor(deployment.chainId, deployment.address, input.familyId, input.version, 'ORIGINAL');
      return send(
        'anchor',
        [input.familyId, input.version, input.parentId, input.docHash, input.manifestHash, input.opinionCommitment],
        recordId,
      );
    },
    async anchorCopy(originalId, docHash) {
      const original = await reader.getRecord(originalId);
      // An unknown original still goes to the contract, which refuses it by name.
      const recordId = original
        ? recordIdFor(deployment.chainId, deployment.address, original.familyId, original.version, 'DISTRIBUTION_COPY')
        : ZERO_HASH;
      return send('anchorDistributionCopy', [originalId, docHash], recordId);
    },
    revoke(recordId, reasonCode) {
      return send('revoke', [recordId, reasonCode], recordId);
    },
  };
}
