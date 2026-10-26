/**
 * Deploys AuditReportRegistry and records it in deployments/<network>.json.
 *
 *   npx tsx scripts/deploy-registry.ts sepolia
 *   npx tsx scripts/deploy-registry.ts base-sepolia      (or optimism-sepolia, arbitrum-sepolia)
 *
 * Of the production candidates (mainnet, base, optimism, arbitrum), the owner
 * chose Arbitrum One (#63, docs/decision-production-chain.md); the others are
 * refused. Arbitrum One is deployed to only once its testnet has been:
 * deployments/arbitrum-sepolia.json must exist (#123).
 *
 * Reads, from the environment (never from a committed file):
 *   DEPLOYER_PRIVATE_KEY  becomes the owner; refused if it holds more than 0.1 ETH
 *   <NETWORK>_RPC_URL     the endpoint to deploy through, e.g. SEPOLIA_RPC_URL
 *   ISSUER_ADDRESS        the issuer key to register (a different key)
 *   ISSUER_ORG_NAME       the audit firm's name; its keccak256 is the org id
 *   REVOCATION_DELAY_HOURS optional; how long a revocation waits before it takes effect,
 *                         during which the owner may cancel it (#95). Default 24;
 *                         at least 1 and at most 720 (the contract's cap, 30 days).
 *                         `local` defaults to 0, which makes revocation immediate.
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
import { CHOSEN_PRODUCTION_NETWORK, deploymentPath, isNetworkName, NETWORKS, PRODUCTION_NETWORKS, REHEARSAL_NETWORK, rpcUrlFor, rpcUrlVariable } from '../src/lib/chain/networks';

const ROOT = path.resolve(import.meta.dirname, '..');
const MAX_DEPLOYER_BALANCE = parseEther('0.1');
const DEFAULT_REVOCATION_DELAY_HOURS = 24;
const MIN_REVOCATION_DELAY_HOURS = 1;
/** The contract's MAX_REVOCATION_DELAY. */
const MAX_REVOCATION_DELAY_HOURS = 30 * 24;

/** The revocation delay, in seconds. Below an hour, the owner could not cancel a stolen key's revocation in time. */
function revocationDelaySeconds(network: string): number {
  const raw = process.env.REVOCATION_DELAY_HOURS;
  const local = network === 'local';
  if (raw === undefined || raw === '') return local ? 0 : DEFAULT_REVOCATION_DELAY_HOURS * 3600;
  const hours = Number(raw);
  if (!Number.isInteger(hours) || hours < 0) fail('REVOCATION_DELAY_HOURS is not a whole number of hours');
  if (!local && hours < MIN_REVOCATION_DELAY_HOURS) fail(`REVOCATION_DELAY_HOURS must be at least ${MIN_REVOCATION_DELAY_HOURS} outside a local chain`);
  if (hours > MAX_REVOCATION_DELAY_HOURS) fail(`REVOCATION_DELAY_HOURS must be at most ${MAX_REVOCATION_DELAY_HOURS} (30 days)`);
  return hours * 3600;
}

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
  if (PRODUCTION_NETWORKS.includes(network) && network !== CHOSEN_PRODUCTION_NETWORK) {
    fail(`${network} is a production network the owner did not choose: production is ${CHOSEN_PRODUCTION_NETWORK} (#63)`);
  }
  const rehearsal = REHEARSAL_NETWORK[network];
  if (rehearsal && !fs.existsSync(deploymentPath(rehearsal, ROOT))) {
    fail(`${network} is deployed to only after its testnet: deployments/${rehearsal}.json does not exist yet (#123)`);
  }
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
  const delay = revocationDelaySeconds(network);

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

  console.log(`Deploying AuditReportRegistry to ${network} from ${deployer.address}, revocation delay ${delay / 3600} h…`);
  const deployment = await deployRegistry({
    publicClient,
    walletClient,
    issuer: { address: getAddress(issuerAddress), orgId: orgIdFor(orgName) },
    revocationDelaySeconds: delay,
  });

  const record = {
    network,
    chainId: deployment.chainId,
    address: deployment.address,
    runtimeBytecodeHash: deployment.runtimeBytecodeHash,
    deployTxHash: deployment.deployTxHash,
    deployBlock: deployment.deployBlock,
    owner: deployer.address,
    revocationDelaySeconds: deployment.revocationDelaySeconds,
    issuer: { address: getAddress(issuerAddress), orgId: orgIdFor(orgName), orgName, setIssuerTxHash: deployment.issuerTxHash },
  };
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`Deployed at ${deployment.address} (block ${deployment.deployBlock}). Wrote ${path.relative(ROOT, target)}.`);

  if (network === 'local') return;
  // One Etherscan key covers every chain here; forge picks the explorer by chain id.
  const constructorArgs = encodeAbiParameters([{ type: 'address' }, { type: 'uint32' }], [deployer.address, delay]);
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
