import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createWalletClient, encodeFunctionData, getAddress, http, parseEther, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { orgIdFor } from '@/lib/chain/deploy';
import { registryAbi } from '@/lib/chain/registry-artifact';
import { startAnvil, type AnvilHandle } from './anvil';
import { deployOn, ISSUER_ORG, type Registry } from './registry-harness';

/**
 * scripts/owner-call.ts (#67, #68): it prints what the owner must execute and
 * sends nothing, except an issuer change with --send from an owner that is a
 * single key; it never sends an ownership move; it refuses, by name, a call
 * that would fail.
 */

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const run = promisify(execFile);

let anvil: AnvilHandle;
let registry: Registry;
let deploymentFile: string;
let firstOwner: Address;
let firstIssuer: Address;

/** Only what the script needs: nothing from the caller's environment reaches it, an OWNER_PRIVATE_KEY least of all. */
const scriptEnv = (extra: Record<string, string> = {}) => ({ PATH: process.env.PATH, LOCAL_RPC_URL: anvil.url, ...extra }) as unknown as NodeJS.ProcessEnv;

async function ownerCall(args: string[], env: Record<string, string> = {}) {
  try {
    const { stdout } = await run(path.join(ROOT, 'node_modules', '.bin', 'tsx'), ['scripts/owner-call.ts', 'local', ...args, '--deployment', deploymentFile], {
      cwd: ROOT,
      env: scriptEnv(env),
    });
    return { code: 0, out: JSON.parse(stdout) as { message: string; transaction: { from: Address; to: Address; value: string; data: Hex; hash?: Hex } } };
  } catch (error) {
    const e = error as { code: number; stderr: string };
    return { code: e.code, error: e.stderr };
  }
}

const read = <T>(functionName: 'owner' | 'pendingOwner') => registry.publicClient.readContract({ address: registry.deployment.address, abi: registryAbi, functionName }) as Promise<T>;
const issuerOf = (key: Address) => registry.publicClient.readContract({ address: registry.deployment.address, abi: registryAbi, functionName: 'issuers', args: [key] });

/** Executes a printed transaction from `from`, as the owner would in their wallet or Safe. */
async function execute(tx: { from: Address; to: Address; data: Hex }, account: Address | ReturnType<typeof privateKeyToAccount> = tx.from) {
  const wallet = createWalletClient({ chain: foundry, transport: http(anvil.url), account });
  const hash = await wallet.sendTransaction({ to: tx.to, data: tx.data, chain: foundry });
  await registry.publicClient.waitForTransactionReceipt({ hash });
}

beforeAll(async () => {
  anvil = await startAnvil();
  registry = await deployOn(anvil.url);
  [firstOwner, firstIssuer] = (await createWalletClient({ chain: foundry, transport: http(anvil.url) }).getAddresses()).map((a) => getAddress(a));
  deploymentFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'owner-call-')), 'local.json');
  const { deployment } = registry;
  fs.writeFileSync(
    deploymentFile,
    JSON.stringify({ network: 'local', ...deployment, owner: firstOwner, issuer: { address: firstIssuer, orgId: orgIdFor(ISSUER_ORG), orgName: ISSUER_ORG } }),
  );
}, 60_000);

afterAll(async () => {
  await anvil?.stop();
});

describe('the owner’s calls', () => {
  // A single key standing in for the owner, as on a testnet rehearsal; production's owner is a Safe.
  const ownerKey = generatePrivateKey();
  const owner = privateKeyToAccount(ownerKey);

  it('prints the ownership move for the owner to execute, and never sends it', async () => {
    await expect(ownerCall(['transfer-owner', owner.address, '--send'])).resolves.toMatchObject({ code: 2, error: expect.stringContaining('owner’s own act') });
    const offered = await ownerCall(['transfer-owner', owner.address]);
    expect(offered.code).toBe(0);
    expect(offered.out!.transaction).toMatchObject({
      from: firstOwner,
      to: registry.deployment.address,
      value: '0',
      data: encodeFunctionData({ abi: registryAbi, functionName: 'transferOwnership', args: [owner.address] }),
    });
    expect(await read('pendingOwner')).toBe('0x0000000000000000000000000000000000000000');

    // The owner executes it; ownership moves only when the new owner accepts.
    await execute(offered.out!.transaction);
    expect(await read('owner')).toBe(firstOwner);
    expect(await read('pendingOwner')).toBe(owner.address);
    const accept = await ownerCall(['accept-owner']);
    expect(accept.out!.transaction).toMatchObject({ from: owner.address, data: encodeFunctionData({ abi: registryAbi, functionName: 'acceptOwnership' }) });
    await registry.testClient.setBalance({ address: owner.address, value: parseEther('1') });
    await execute(accept.out!.transaction, owner);
    expect(await read('owner')).toBe(owner.address);
    await expect(ownerCall(['accept-owner'])).resolves.toMatchObject({ code: 2, error: expect.stringContaining('no ownership transfer is pending') });
  });

  it('registers a new issuer key and retires the old one with --send, from the owner’s key only', async () => {
    const orgId = orgIdFor(ISSUER_ORG);
    const next = privateKeyToAccount(generatePrivateKey()).address;
    await expect(ownerCall(['add-issuer', next, '--send'], { OWNER_PRIVATE_KEY: generatePrivateKey() })).resolves.toMatchObject({ code: 2, error: expect.stringContaining('is not the owner') });
    expect(await issuerOf(next)).toEqual([`0x${'0'.repeat(64)}`, false]);

    // Without --send it only prints the call.
    const printed = await ownerCall(['add-issuer', next]);
    expect(printed.out!.transaction).toMatchObject({ from: owner.address, data: encodeFunctionData({ abi: registryAbi, functionName: 'setIssuer', args: [next, orgId, true] }) });
    expect(await issuerOf(next)).toEqual([`0x${'0'.repeat(64)}`, false]);

    const added = await ownerCall(['add-issuer', next, '--send'], { OWNER_PRIVATE_KEY: ownerKey });
    expect(added).toMatchObject({ code: 0, out: { message: 'sent', transaction: { hash: expect.stringMatching(/^0x[0-9a-f]{64}$/) } } });
    expect(await issuerOf(next)).toEqual([orgId, true]);
    const retired = await ownerCall(['remove-issuer', firstIssuer, '--send'], { OWNER_PRIVATE_KEY: ownerKey });
    expect(retired.code).toBe(0);
    expect(await issuerOf(firstIssuer)).toEqual([orgId, false]);
  });

  it('refuses, by name, what would fail or what is not this registry', async () => {
    // A key registered to another firm keeps that firm for good.
    const elsewhere = privateKeyToAccount(generatePrivateKey()).address;
    await execute({ from: owner.address, to: registry.deployment.address, data: encodeFunctionData({ abi: registryAbi, functionName: 'setIssuer', args: [elsewhere, orgIdFor('Another Firm'), true] }) }, owner);
    await expect(ownerCall(['add-issuer', elsewhere])).resolves.toMatchObject({ code: 2, error: expect.stringContaining('registered to another firm') });
    await expect(ownerCall(['remove-issuer', privateKeyToAccount(generatePrivateKey()).address])).resolves.toMatchObject({ code: 2, error: expect.stringContaining('not an issuer key') });
    await expect(ownerCall(['add-issuer', owner.address])).resolves.toMatchObject({ code: 2, error: expect.stringContaining('must not be the owner') });
    await expect(ownerCall(['add-issuer', 'not-an-address'])).resolves.toMatchObject({ code: 2 });

    // A deployment record naming an address that holds no registry.
    const wrong = path.join(path.dirname(deploymentFile), 'wrong.json');
    fs.writeFileSync(wrong, fs.readFileSync(deploymentFile, 'utf8').replace(registry.deployment.address, owner.address));
    const { stderr } = await run(path.join(ROOT, 'node_modules', '.bin', 'tsx'), ['scripts/owner-call.ts', 'local', 'add-issuer', owner.address, '--deployment', wrong], {
      cwd: ROOT,
      env: scriptEnv(),
    }).catch((e: { stderr: string }) => e);
    expect(stderr).toContain('does not hold the registry');
  });
});
