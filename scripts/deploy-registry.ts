/**
 * Deploys AuditReportRegistry and records it in deployments/<network>.json.
 *
 *   npx tsx scripts/deploy-registry.ts sepolia
 *   npx tsx scripts/deploy-registry.ts base-sepolia      (or optimism-sepolia, arbitrum-sepolia)
 *
 * The production networks (mainnet, base, optimism, arbitrum) are refused
 * until the owner has chosen one (#63, docs/decision-production-chain.md).
 *
 * Reads, from the environment (never from a committed file):
 *   DEPLOYER_PRIVATE_KEY  becomes the owner; refused if it holds more than 0.1 ETH
 *   <NETWORK>_RPC_URL     the endpoint to deploy through, e.g. SEPOLIA_RPC_URL
 *   ISSUER_ADDRESS        the issuer key to register (a different key)
 *   ISSUER_ORG_NAME       the audit firm's name; its keccak256 is the org id
 *   ETHERSCAN_API_KEY     optional; when set, the source is verified on Etherscan
 *   DEPLOYMENT_FILE       optional; write the record there instead of deployments/<network>.json
 *
 * `local` deploys to an Anvil node at LOCAL_RPC_URL (default http://127.0.0.1:8545)
 * and writes deployments/local.json, which git ignores. It exists to rehearse
 * this script.
 *
 * Refuses to overwrite an existing deployment file: a second registry would
 * split every family's history in two.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createPublicClient, createWalletClient, encodeAbiParameters, formatEther, getAddress, http, isAddress, isHex, parseEther, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { deployRegistry, orgIdFor } from '../src/lib/chain/deploy';
import { deploymentPath, isNetworkName, NETWORKS, PRODUCTION_NETWORKS, rpcUrlFor, rpcUrlVariable } from '../src/lib/chain/networks';

const ROOT = path.resolve(import.meta.dirname, '..');
const MAX_DEPLOYER_BALANCE = parseEther('0.1');

function fail(message: string): never {
  console.error(`Refused: ${message}`);
  process.exit(1);
}

function env(name: string): string {
  const value = process.env[name];
  if (!value) fail(`${name} is not set`);
  return value;
}

async function main() {
  const network = process.argv[2];
  if (!isNetworkName(network)) fail(`usage: npx tsx scripts/deploy-registry.ts <${Object.keys(NETWORKS).join('|')}>`);
  if (PRODUCTION_NETWORKS.includes(network)) fail(`${network} is a production network: deploying to one waits on the owner's choice of chain (#63)`);
  const chain = NETWORKS[network];
  if (network !== 'local') env(rpcUrlVariable(network));
  const rpcUrl = rpcUrlFor(network);

  // DEPLOYMENT_FILE writes the record elsewhere, as the worker reads one from elsewhere (rehearsals, tests).
  const target = process.env.DEPLOYMENT_FILE ? path.resolve(process.env.DEPLOYMENT_FILE) : deploymentPath(network, ROOT);
  if (fs.existsSync(target)) fail(`${path.relative(ROOT, target)} already exists`);

  const key = env('DEPLOYER_PRIVATE_KEY');
  if (!isHex(key) || key.length !== 66) fail('DEPLOYER_PRIVATE_KEY is not a 32-byte hex key');
  const deployer = privateKeyToAccount(key);
  const issuerAddress = env('ISSUER_ADDRESS');
  if (!isAddress(issuerAddress)) fail('ISSUER_ADDRESS is not an address');
  if (getAddress(issuerAddress) === deployer.address) fail('the issuer key must not be the deployer key');
  const orgName = env('ISSUER_ORG_NAME');

  const transport = http(rpcUrl);
  const publicClient = createPublicClient({ chain, transport }) as PublicClient;
  const walletClient = createWalletClient({ chain, transport, account: deployer });

  const chainId = await publicClient.getChainId();
  if (chainId !== chain.id) fail(`the RPC endpoint is on chain ${chainId}, expected ${chain.id}`);
  const balance = await publicClient.getBalance({ address: deployer.address });
  // The deployer becomes the owner, so a leaked deployer key is the worst leak
  // there is; keeping its balance small bounds what it can pay for.
  if (balance > MAX_DEPLOYER_BALANCE) {
    fail(`the deployer holds ${formatEther(balance)} ETH; move all but ${formatEther(MAX_DEPLOYER_BALANCE)} to the issuer key, which pays for anchoring`);
  }

  console.log(`Deploying AuditReportRegistry to ${network} from ${deployer.address}…`);
  const deployment = await deployRegistry({
    publicClient,
    walletClient,
    issuer: { address: getAddress(issuerAddress), orgId: orgIdFor(orgName) },
  });

  const record = {
    network,
    chainId: deployment.chainId,
    address: deployment.address,
    runtimeBytecodeHash: deployment.runtimeBytecodeHash,
    deployTxHash: deployment.deployTxHash,
    deployBlock: deployment.deployBlock,
    owner: deployer.address,
    issuer: { address: getAddress(issuerAddress), orgId: orgIdFor(orgName), orgName, setIssuerTxHash: deployment.issuerTxHash },
  };
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`Deployed at ${deployment.address} (block ${deployment.deployBlock}). Wrote ${path.relative(ROOT, target)}.`);

  if (network === 'local') return;
  // One Etherscan key covers every chain here; forge picks the explorer by chain id.
  const constructorArgs = encodeAbiParameters([{ type: 'address' }], [deployer.address]);
  const verify = ['verify-contract', deployment.address, 'src/AuditReportRegistry.sol:AuditReportRegistry', '--chain', String(chain.id), '--constructor-args', constructorArgs, '--watch'];
  if (!process.env.ETHERSCAN_API_KEY) {
    console.log(`ETHERSCAN_API_KEY is not set. Verify the source later with:\n  (cd contracts && forge ${verify.join(' ')})`);
    return;
  }
  const result = spawnSync('forge', verify, { cwd: path.join(ROOT, 'contracts'), stdio: 'inherit' });
  if (result.status !== 0) fail('Etherscan verification failed; the deployment itself succeeded and is recorded');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
