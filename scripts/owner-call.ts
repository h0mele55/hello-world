/**
 * The registry owner's acts: registering and retiring issuer keys, cancelling
 * a revocation before it takes effect, voiding an audit-log head a stolen key
 * wrote, recording or voiding a re-anchor root, and moving ownership to a Safe
 * (docs/runbooks/key-rotation.md, docs/runbooks/stolen-issuer-key.md,
 * docs/runbooks/sepolia-sunset.md, #65, #67, #68, #94, #95).
 *
 *   npx tsx scripts/owner-call.ts <network> add-issuer <address>          setIssuer(address, firm, true)
 *   npx tsx scripts/owner-call.ts <network> remove-issuer <address>       setIssuer(address, firm, false)
 *   npx tsx scripts/owner-call.ts <network> cancel-revocation <recordId>  cancelRevocation(recordId), before it takes effect
 *   npx tsx scripts/owner-call.ts <network> void-audit-head <index>       voidAuditHead(firm, index): a head the firm's log never held
 *   npx tsx scripts/owner-call.ts <network> record-reanchor-root <archive.json>
 *                                                                        recordReanchorRoot(...): the root of an archive scripts/reanchor.ts built
 *   npx tsx scripts/owner-call.ts <network> void-reanchor-root <index>    voidReanchorRoot(index): a root recorded in error
 *   npx tsx scripts/owner-call.ts <network> transfer-owner <safe>         transferOwnership(safe), by the current owner
 *   npx tsx scripts/owner-call.ts <network> accept-owner                  acceptOwnership(), by the new owner
 *
 * Options:
 *   --deployment <file>  instead of deployments/<network>.json
 *   --send               send it with OWNER_PRIVATE_KEY. Only for the issuer
 *                        calls, a cancellation, a void and a re-anchor root, and only while the owner is
 *                        a single key (Anvil, a testnet rehearsal). Moving
 *                        ownership is never sent from here: the owner
 *                        executes it.
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
import { CannotVerify, checkReanchorSet } from '../src/lib/verify-core';

const ZERO = '0x0000000000000000000000000000000000000000';
const ZERO_ORG = `0x${'0'.repeat(64)}`;

function refuse(message: string): never {
  console.error(JSON.stringify({ level: 'error', message: `owner-call refused: ${message}` }));
  process.exit(2);
}

const IssuerRecord = z.object({ issuer: z.object({ orgId: z.string().regex(/^0x[0-9a-fA-F]{64}$/), orgName: z.string().min(1) }) });

type Action = 'add-issuer' | 'remove-issuer' | 'cancel-revocation' | 'void-audit-head' | 'record-reanchor-root' | 'void-reanchor-root' | 'transfer-owner' | 'accept-owner';
const ACTIONS: readonly Action[] = ['add-issuer', 'remove-issuer', 'cancel-revocation', 'void-audit-head', 'record-reanchor-root', 'void-reanchor-root', 'transfer-owner', 'accept-owner'];
/** A cancellation that lands after the revocation takes effect reverts; below this, say so. */
const CANCEL_MARGIN_SECONDS = 15 * 60;

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { deployment: { type: 'string' }, send: { type: 'boolean', default: false } } });
  const [network, action, argument] = positionals;
  if (!isNetworkName(network) || !ACTIONS.includes(action as Action)) refuse(`usage: owner-call <${Object.keys(NETWORKS).join('|')}> <${ACTIONS.join('|')}> [address | record id | head index | archive.json | root index] [--deployment <file>] [--send]`);
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

  let call:
    | { functionName: 'setIssuer'; args: readonly [Address, Hex, boolean] }
    | { functionName: 'cancelRevocation'; args: readonly [Hex] }
    | { functionName: 'voidAuditHead'; args: readonly [Hex, bigint] }
    | { functionName: 'recordReanchorRoot'; args: readonly [Hex, bigint, Address, number, number] }
    | { functionName: 'voidReanchorRoot'; args: readonly [bigint] }
    | { functionName: 'transferOwnership'; args: readonly [Address] }
    | { functionName: 'acceptOwnership'; args: readonly [] };
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
  } else if (act === 'cancel-revocation') {
    if (!argument || !isHex(argument) || argument.length !== 66) refuse('give the record id (32 bytes, 0x-prefixed hex)');
    const recordId = argument.toLowerCase() as Hex;
    const [record, latest] = await Promise.all([
      publicClient.readContract({ ...registry, functionName: 'getRecord', args: [recordId] }),
      publicClient.getBlock({ blockTag: 'latest' }),
    ]);
    if (record.docHash === ZERO_ORG) refuse(`${recordId} is not a record of this registry`);
    if (record.revokeReason === 0) refuse(`${recordId} has no revocation to cancel`);
    if (record.revoked) refuse(`the revocation of ${recordId} is already in effect, which is terminal: it cannot be cancelled`);
    const family = await publicClient.readContract({ ...registry, functionName: 'familyOrg', args: [record.familyId] });
    if (family.toLowerCase() !== orgId) console.error(JSON.stringify({ level: 'warn', message: `${recordId} belongs to another firm (${family}), not ${firm.data.issuer.orgName}` }));
    const effectiveAt = new Date(record.revokeEffectiveAt * 1000).toISOString();
    const left = record.revokeEffectiveAt - Number(latest.timestamp);
    if (left < CANCEL_MARGIN_SECONDS) console.error(JSON.stringify({ level: 'warn', message: `the revocation takes effect in ${Math.max(left, 0)} s, at ${effectiveAt}; a cancellation mined after that reverts` }));
    call = { functionName: 'cancelRevocation', args: [recordId] };
    description = `cancel the pending revocation of record ${recordId} (reason code ${record.revokeReason}), which would take effect at ${effectiveAt}`;
  } else if (act === 'void-audit-head') {
    // The index the console's registry-watch card and the check's error name (#94).
    if (!argument || !/^\d+$/.test(argument)) refuse('give the head’s index (a whole number) in the firm’s list');
    const index = BigInt(argument);
    const [head] = await publicClient.readContract({ ...registry, functionName: 'auditHeads', args: [orgId, index, 1n] });
    if (!head) refuse(`${firm.data.issuer.orgName} has no audit-log head ${index}`);
    if (head.voided) refuse(`audit-log head ${index} is already voided`);
    const recordedAt = new Date(head.recordedAt * 1000).toISOString();
    call = { functionName: 'voidAuditHead', args: [orgId, index] };
    description = `void audit-log head ${index} of ${firm.data.issuer.orgName} (${head.head}, written by ${head.issuer} at ${recordedAt}): the nightly check stops holding the log to it. Only for a head the firm's log never held, never to make a rewritten log pass`;
  } else if (act === 'record-reanchor-root') {
    // A root vouches for every record under it: the archive is held to its own checks first (#65).
    if (!argument) refuse('give the archive.json scripts/reanchor.ts wrote');
    let archive;
    try {
      archive = checkReanchorSet(JSON.parse(fs.readFileSync(argument, 'utf8')));
    } catch (error) {
      refuse(`${argument} is not an archive that holds together: ${error instanceof CannotVerify ? error.message : 'unreadable'}`);
    }
    if (!archive.complete) refuse(`${argument} is a single record's proof; record the root of the whole archive`);
    if (archive.target.chainId !== chain.id || archive.target.registry.toLowerCase() !== deployment.address.toLowerCase()) refuse(`${argument} was built for another registry (${archive.target.registry} on chain ${archive.target.chainId})`);
    const total = await publicClient.readContract({ ...registry, functionName: 'reanchorRootCount' });
    const roots = await publicClient.readContract({ ...registry, functionName: 'reanchorRoots', args: [0n, total] });
    if (roots.some((r) => !r.voided && r.root.toLowerCase() === archive.root)) console.error(JSON.stringify({ level: 'warn', message: `root ${archive.root} is already recorded; the call adds it again` }));
    call = { functionName: 'recordReanchorRoot', args: [archive.root, BigInt(archive.source.chainId), archive.source.registry, archive.source.block, archive.count] };
    description = `record the root ${archive.root} of the ${archive.count} records registry ${archive.source.registry} on chain ${archive.source.chainId} held at block ${archive.source.block}: from then on each verifies through its proof. Only after scripts/reanchor.ts check has been run against a copy, and the archive is published`;
  } else if (act === 'void-reanchor-root') {
    if (!argument || !/^\d+$/.test(argument)) refuse('give the root’s index (a whole number)');
    const index = BigInt(argument);
    const [entry] = await publicClient.readContract({ ...registry, functionName: 'reanchorRoots', args: [index, 1n] });
    if (!entry) refuse(`the registry has no re-anchor root ${index}`);
    if (entry.voided) refuse(`re-anchor root ${index} is already voided`);
    call = { functionName: 'voidReanchorRoot', args: [index] };
    description = `void re-anchor root ${index} (${entry.root}, ${entry.count} records of ${entry.sourceRegistry} on chain ${entry.sourceChainId}): verifiers stop accepting proofs against it. Only for a root recorded in error; record the corrected one anew`;
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
