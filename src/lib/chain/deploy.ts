import { getAddress, keccak256, toBytes, type Address, type Hash, type Hex, type PublicClient, type WalletClient } from 'viem';
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
 *
 * `revocationDelaySeconds` is how long an issuer's revocation waits before it
 * takes effect, during which the owner may cancel it (#95). Zero, the default
 * here, makes revocation immediate: for test chains only. The deploy script
 * refuses less than an hour anywhere else.
 *
 * `onDeployed` runs once the registry's bytecode checks, before the issuer is
 * registered (#142): the deploy script records the registry there, so a
 * failure in between leaves it recorded, and `resume` then finishes it
 * instead of deploying a second one. Resuming checks the code and the owner,
 * and registers the issuer only if it is not registered already.
 */
export async function deployRegistry(options: {
  publicClient: PublicClient;
  walletClient: WalletClient;
  issuer?: { address: Address; orgId: Hex };
  revocationDelaySeconds?: number;
  onDeployed?: (deployed: { chainId: number; address: Address; deployTxHash: Hash; deployBlock: number; revocationDelaySeconds: number }) => void | Promise<void>;
  resume?: { address: Address; deployTxHash: Hash; deployBlock: number };
}): Promise<Deployment & { deployTxHash: Hash; deployBlock: number; issuerTxHash?: Hash; revocationDelaySeconds: number }> {
  const { publicClient, walletClient, issuer, resume } = options;
  let revocationDelaySeconds = options.revocationDelaySeconds ?? 0;
  const account = walletClient.account;
  if (!account) throw new ChainError('NO_ACCOUNT', 'The wallet client has no account to deploy from');
  const chainId = await publicClient.getChainId();

  let address: Address;
  let deployTxHash: Hash;
  let deployBlock: number;
  if (resume) {
    ({ deployTxHash, deployBlock } = resume);
    address = getAddress(resume.address);
  } else {
    deployTxHash = await walletClient.deployContract({
      abi: registryAbi,
      bytecode: registryBytecode,
      args: [account.address, revocationDelaySeconds],
      account,
      chain: walletClient.chain,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: deployTxHash });
    if (receipt.status !== 'success' || !receipt.contractAddress) throw new TransactionRevertedError(deployTxHash);
    address = getAddress(receipt.contractAddress);
    deployBlock = Number(receipt.blockNumber);
  }

  const code = await publicClient.getCode({ address });
  if (!code || keccak256(code) !== registryRuntimeBytecodeHash) throw new BytecodeMismatchError(address);
  if (resume) {
    const [owner, delay] = await Promise.all([
      publicClient.readContract({ address, abi: registryAbi, functionName: 'owner' }),
      publicClient.readContract({ address, abi: registryAbi, functionName: 'revocationDelay' }),
    ]);
    if (owner.toLowerCase() !== account.address.toLowerCase()) throw new ChainError('NOT_OWNER', `the registry at ${address} is owned by ${owner}, not this deployer`);
    revocationDelaySeconds = Number(delay);
  } else {
    await options.onDeployed?.({ chainId, address, deployTxHash, deployBlock, revocationDelaySeconds });
  }

  let issuerTxHash: Hash | undefined;
  // On a resume the issuer may already be registered: by the run that failed after sending, say.
  const registered = issuer && resume ? await publicClient.readContract({ address, abi: registryAbi, functionName: 'issuers', args: [issuer.address] }) : null;
  if (registered && registered[0] !== `0x${'0'.repeat(64)}` && registered[0].toLowerCase() !== issuer!.orgId.toLowerCase()) {
    throw new ChainError('ISSUER_OTHER_FIRM', `${issuer!.address} is registered to another firm on the registry at ${address}`);
  }
  if (issuer && !(registered && registered[1])) {
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
    chainId,
    address,
    runtimeBytecodeHash: registryRuntimeBytecodeHash,
    deployTxHash,
    deployBlock,
    issuerTxHash,
    revocationDelaySeconds,
  };
}
