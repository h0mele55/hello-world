/**
 * A retired chain for the end-to-end tests (#126). Run once, after the local
 * registry is deployed and before the app and the standalone verifier are
 * built:
 *
 *   DEPLOYER_PRIVATE_KEY=<the local registry's owner> E2E_REANCHOR_DIR=<dir> npx tsx tests/e2e/reanchor-fixture.ts
 *
 * It starts a second Anvil node standing in for Sepolia, deploys a registry
 * there and anchors two versions of one report, archives that registry
 * (scripts/reanchor.ts's builder), has the local registry's owner record the
 * archive's root, and then stops the node: from then on the reports can be
 * checked only through the archive and its root. It writes, into the dir:
 *
 *   archive.json   for REANCHOR_ARCHIVES
 *   v1.pdf, v2.pdf the two versions' files
 *   fixture.json   what the tests expect: the retired registry, its block, the root's index
 *
 * The owner's key comes from the environment only, as in CI.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createPublicClient, createTestClient, createWalletClient, http, type Hex, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { loadDeployment } from '@/lib/chain/networks';
import { buildReanchorArchive } from '@/lib/chain/reanchor-build';
import { registryAbi } from '@/lib/chain/registry-artifact';
import { findRecordedRoot, checkReanchorSet } from '@/lib/verify-core';
import { startAnvil } from '../integration/anvil';
import { anchorOriginal, deployOn, finalise, ISSUER_ORG } from '../integration/registry-harness';

const SEPOLIA = 11155111;

function fail(message: string): never {
  console.error(`reanchor-fixture: ${message}`);
  process.exit(1);
}

async function main() {
  const ownerKey = process.env.DEPLOYER_PRIVATE_KEY as Hex | undefined;
  const dir = process.env.E2E_REANCHOR_DIR;
  const targetUrl = process.env.LOCAL_RPC_URL || 'http://127.0.0.1:8545';
  if (!ownerKey || !dir) fail('set DEPLOYER_PRIVATE_KEY (the local registry owner) and E2E_REANCHOR_DIR');
  const target = loadDeployment('local');
  fs.mkdirSync(dir, { recursive: true });

  const node = await startAnvil({ chainId: SEPOLIA });
  try {
    const source = await deployOn(node.url, { chainId: SEPOLIA });
    // Unique bytes per run, so the local registry can never already hold them.
    const tag = `%e2e-reanchor ${Date.now()}\n`;
    const versionOf = (name: string) => new Uint8Array([...fs.readFileSync(path.join('tests', 'fixtures', 'pdf', name)), ...Buffer.from(tag)]);
    const v1 = versionOf('en-unmodified.pdf');
    const v2 = versionOf('en-qualified.pdf');
    const family = `0x${'e2'.repeat(32)}` as Hex;
    const first = await anchorOriginal(source, v1, family);
    await anchorOriginal(source, v2, family, 2, first.recordId);
    await finalise(source);

    const sourceClient = createPublicClient({ chain: { ...foundry, id: SEPOLIA }, transport: http(node.url) }) as PublicClient;
    const { archive } = await buildReanchorArchive({
      clients: [sourceClient, sourceClient],
      source: { ...source.deployment, deployBlock: 0 },
      target: { chainId: target.chainId, registry: target.address },
      issuerNames: [ISSUER_ORG],
    });

    // The local registry's owner records the root, as owner-call prints it for a real owner.
    const owner = privateKeyToAccount(ownerKey);
    const targetClient = createPublicClient({ chain: foundry, transport: http(targetUrl) }) as PublicClient;
    const call = {
      address: target.address,
      abi: registryAbi,
      functionName: 'recordReanchorRoot',
      args: [archive.root, BigInt(archive.source.chainId), archive.source.registry, archive.source.block, archive.records.length],
    } as const;
    await targetClient.simulateContract({ ...call, account: owner });
    const hash = await createWalletClient({ chain: foundry, transport: http(targetUrl), account: owner }).writeContract(call);
    await targetClient.waitForTransactionReceipt({ hash });
    await createTestClient({ chain: foundry, mode: 'anvil', transport: http(targetUrl) }).mine({ blocks: 3 });

    const set = checkReanchorSet(JSON.parse(JSON.stringify(archive)));
    const recorded = await findRecordedRoot(set, { chainId: target.chainId, registry: target.address, runtimeBytecodeHash: target.runtimeBytecodeHash, rpcUrls: [targetUrl, targetUrl] });

    fs.writeFileSync(path.join(dir, 'archive.json'), JSON.stringify(archive, null, 2));
    fs.writeFileSync(path.join(dir, 'v1.pdf'), v1);
    fs.writeFileSync(path.join(dir, 'v2.pdf'), v2);
    const fixture = {
      sourceRpcUrl: node.url,
      sourceChainId: SEPOLIA,
      sourceRegistry: archive.source.registry,
      sourceBlock: archive.source.block,
      count: archive.records.length,
      index: recorded.index,
      recordedBlock: recorded.recordedBlock,
      issuer: ISSUER_ORG,
    };
    fs.writeFileSync(path.join(dir, 'fixture.json'), JSON.stringify(fixture, null, 2));
    console.log(JSON.stringify({ dir, ...fixture }));
  } finally {
    // The retired chain is gone before any test runs.
    await node.stop();
  }
}

main().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
