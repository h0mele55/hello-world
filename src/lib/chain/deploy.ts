import { keccak256, toBytes, type Address, type Hash, type Hex, type PublicClient, type WalletClient } from 'viem';
import type { Deployment } from './deployment';
import { BytecodeMismatchError, ChainError, TransactionRevertedError } from './errors';
import { registryAbi, registryBytecode, registryRuntimeBytecodeHash } from './registry-artifact';

/** An issuer organisation's on-chain id: keccak256 of its name. */
export function orgIdFor(name: string): Hex {
  return keccak256(toBytes(name));
}

/**
 * Deploys the registry from the wallet client's account (which becomes the
 * owner) and, optionally, registers one issuer key. Used by the Anvil
 * integration tests and by scripts/deploy-registry.ts for Sepolia, so both
 * take the same path.
 */
export async function deployRegistry(options: {
  publicClient: PublicClient;
  walletClient: WalletClient;
  issuer?: { address: Address; orgId: Hex };
}): Promise<Deployment & { deployTxHash: Hash; deployBlock: number; issuerTxHash?: Hash }> {
  const { publicClient, walletClient, issuer } = options;
  const account = walletClient.account;
  if (!account) throw new ChainError('NO_ACCOUNT', 'The wallet client has no account to deploy from');

  const deployTxHash = await walletClient.deployContract({
    abi: registryAbi,
    bytecode: registryBytecode,
    args: [account.address],
    account,
    chain: walletClient.chain,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: deployTxHash });
  if (receipt.status !== 'success' || !receipt.contractAddress) throw new TransactionRevertedError(deployTxHash);
  const address = receipt.contractAddress;

  const code = await publicClient.getCode({ address });
  if (!code || keccak256(code) !== registryRuntimeBytecodeHash) throw new BytecodeMismatchError(address);

  let issuerTxHash: Hash | undefined;
  if (issuer) {
    issuerTxHash = await walletClient.writeContract({
      address,
      abi: registryAbi,
      functionName: 'setIssuer',
      args: [issuer.address, issuer.orgId, true],
      account,
      chain: walletClient.chain,
    });
    const issuerReceipt = await publicClient.waitForTransactionReceipt({ hash: issuerTxHash });
    if (issuerReceipt.status !== 'success') throw new TransactionRevertedError(issuerTxHash);
  }

  return {
    chainId: await publicClient.getChainId(),
    address,
    runtimeBytecodeHash: registryRuntimeBytecodeHash,
    deployTxHash,
    deployBlock: Number(receipt.blockNumber),
    issuerTxHash,
  };
}
