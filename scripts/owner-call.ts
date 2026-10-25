/**
 * The registry owner's acts: registering and retiring issuer keys, and moving
 * ownership to a Safe (docs/runbooks/key-rotation.md, #67, #68).
 *
 *   npx tsx scripts/owner-call.ts <network> add-issuer <address>      setIssuer(address, firm, true)
 *   npx tsx scripts/owner-call.ts <network> remove-issuer <address>   setIssuer(address, firm, false)
 *   npx tsx scripts/owner-call.ts <network> transfer-owner <safe>     transferOwnership(safe), by the current owner
 *   npx tsx scripts/owner-call.ts <network> accept-owner              acceptOwnership(), by the new owner
 *
 * Options:
 *   --deployment <file>  instead of deployments/<network>.json
 *   --send               send it with OWNER_PRIVATE_KEY. Only for the issuer
 *                        calls, and only while the owner is a single key
 *                        (Anvil, a testnet rehearsal). Moving ownership is
 *                        never sent from here: the owner executes it.
 *
 * Without --send it sends nothing. It checks the chain and the contract
 * against the deployment record, simulates the call from the account that
 * must make it, and prints the transaction ({ to, value, data, from }) for
 * that account to execute: from a hardware wallet, or in the Safe's
 * Transaction Builder (custom data).
 *
 * Reads the network's <NETWORK>_RPC_URL (e.g. SEPOLIA_RPC_URL), and OWNER_PRIVATE_KEY only with --send.
 */
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { createPublicClient, createWalletClient, encodeFunctionData, getAddress, http, isAddress, isHex, keccak256, type Address, type Hex, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { z } from 'zod';
import { toRegistryError } from '../src/lib/chain/adapter';
import { RegistryRevertError } from '../src/lib/chain/errors';
import { deploymentPath, isNetworkName, loadDeploymentFile, NETWORKS, rpcUrlFor } from '../src/lib/chain/networks';
import { registryAbi } from '../src/lib/chain/registry-artifact';

const ZERO = '0x0000000000000000000000000000000000000000';
const ZERO_ORG = `0x${'0'.repeat(64)}`;

function refuse(message: string): never {
  console.error(JSON.stringify({ level: 'error', message: `owner-call refused: ${message}` }));
  process.exit(2);
}

const IssuerRecord = z.object({ issuer: z.object({ orgId: z.string().regex(/^0x[0-9a-fA-F]{64}$/), orgName: z.string().min(1) }) });

type Action = 'add-issuer' | 'remove-issuer' | 'transfer-owner' | 'accept-owner';
const ACTIONS: readonly Action[] = ['add-issuer', 'remove-issuer', 'transfer-owner', 'accept-owner'];

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { deployment: { type: 'string' }, send: { type: 'boolean', default: false } } });
  const [network, action, argument] = positionals;
  if (!isNetworkName(network) || !ACTIONS.includes(action as Action)) refuse(`usage: owner-call <${Object.keys(NETWORKS).join('|')}> <${ACTIONS.join('|')}> [address] [--deployment <file>] [--send]`);
  const act = action as Action;
  if (values.send && (act === 'transfer-owner' || act === 'accept-owner')) refuse('moving ownership is the owner’s own act: run without --send and execute the printed transaction');

  const file = values.deployment ?? deploymentPath(network);
  const deployment = loadDeploymentFile(network, file);
  const firm = IssuerRecord.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
  if (!firm.success) refuse(`${file} does not name the firm (issuer.orgId, issuer.orgName)`);
  const orgId = firm.data.issuer.orgId.toLowerCase() as Hex;

  const chain = NETWORKS[network];
  const publicClient = createPublicClient({ chain, transport: http(rpcUrlFor(network)) }) as PublicClient;
  if ((await publicClient.getChainId()) !== chain.id) refuse(`the RPC endpoint is not on ${network}`);
  const code = await publicClient.getCode({ address: deployment.address });
  if (!code || keccak256(code) !== deployment.runtimeBytecodeHash) refuse(`${deployment.address} does not hold the registry the deployment record describes`);

  const registry = { address: deployment.address, abi: registryAbi } as const;
  const [owner, pendingOwner] = await Promise.all([
    publicClient.readContract({ ...registry, functionName: 'owner' }),
    publicClient.readContract({ ...registry, functionName: 'pendingOwner' }),
  ]);

  let call: { functionName: 'setIssuer'; args: readonly [Address, Hex, boolean] } | { functionName: 'transferOwnership'; args: readonly [Address] } | { functionName: 'acceptOwnership'; args: readonly [] };
  let from: Address = owner;
  let description: string;
  if (act === 'add-issuer' || act === 'remove-issuer') {
    if (!argument || !isAddress(argument)) refuse('give the issuer key’s address');
    const key = getAddress(argument);
    if (key === owner) refuse('an issuer key must not be the owner');
    const [currentOrg, active] = await publicClient.readContract({ ...registry, functionName: 'issuers', args: [key] });
    if (currentOrg !== ZERO_ORG && currentOrg.toLowerCase() !== orgId) refuse(`${key} is registered to another firm (${currentOrg}); a key’s firm never changes`);
    if (act === 'remove-issuer' && currentOrg === ZERO_ORG) refuse(`${key} is not an issuer key of this registry`);
    if ((act === 'add-issuer') === active) console.error(JSON.stringify({ level: 'warn', message: `${key} is already ${active ? 'active' : 'inactive'}; the call changes nothing` }));
    call = { functionName: 'setIssuer', args: [key, orgId, act === 'add-issuer'] };
    description = act === 'add-issuer' ? `register ${key} as an issuer key of ${firm.data.issuer.orgName}` : `retire ${key}: it can no longer write, and what it anchored still verifies`;
  } else if (act === 'transfer-owner') {
    if (!argument || !isAddress(argument) || argument === ZERO) refuse('give the Safe’s address');
    const safe = getAddress(argument);
    if (safe === owner) refuse(`${safe} already owns the registry`);
    if (!(await publicClient.getCode({ address: safe }))) console.error(JSON.stringify({ level: 'warn', message: `${safe} holds no code: it is not a Safe. Ownership moves only when it accepts, so a wrong address can be replaced, but check it` }));
    call = { functionName: 'transferOwnership', args: [safe] };
    description = `step one of two: offer ownership to ${safe}; it takes effect only when ${safe} runs accept-owner`;
  } else {
    if (pendingOwner === ZERO) refuse('no ownership transfer is pending: run transfer-owner first');
    from = pendingOwner;
    call = { functionName: 'acceptOwnership', args: [] };
    description = `step two of two: ${pendingOwner} accepts ownership from ${owner}`;
  }

  try {
    await publicClient.simulateContract({ ...registry, ...call, account: from } as Parameters<PublicClient['simulateContract']>[0]);
  } catch (error) {
    const named = toRegistryError(error);
    refuse(`the call would fail: ${named instanceof RegistryRevertError ? named.errorName : 'unknown reason'}`);
  }
  const transaction = { network, chainId: chain.id, from, to: deployment.address, value: '0', data: encodeFunctionData({ abi: registryAbi, ...call } as Parameters<typeof encodeFunctionData>[0]), description };

  if (!values.send) {
    console.log(JSON.stringify({ level: 'info', message: 'not sent: execute this transaction from the account named in "from"', transaction }, null, 2));
    return;
  }
  const key = process.env.OWNER_PRIVATE_KEY;
  if (!key || !isHex(key) || key.length !== 66) refuse('OWNER_PRIVATE_KEY is not a 32-byte hex key');
  const account = privateKeyToAccount(key);
  if (account.address !== owner) refuse(`OWNER_PRIVATE_KEY is not the owner (${owner})`);
  const wallet = createWalletClient({ chain, transport: http(rpcUrlFor(network)), account });
  const hash = await wallet.writeContract({ ...registry, ...call, account, chain } as Parameters<typeof wallet.writeContract>[0]);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') refuse(`the transaction ${hash} reverted`);
  console.log(JSON.stringify({ level: 'info', message: 'sent', transaction: { ...transaction, hash, blockNumber: Number(receipt.blockNumber) } }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ level: 'error', message: 'owner-call stopped', error: error instanceof Error ? error.name : typeof error }));
  process.exit(2);
});
