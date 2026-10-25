/**
 * Measures what an anchor costs, and how far behind `finalized` runs, on the
 * production candidates (docs/decision-production-chain.md, #63): Ethereum
 * mainnet, Base, OP Mainnet and Arbitrum One. Reads public endpoints only;
 * sends nothing and needs no key.
 *
 *   npx tsx scripts/measure-chain-costs.ts            # a markdown table, then the JSON it came from
 *
 * Per chain:
 *   - the base fee over the last FEE_BLOCKS blocks (median and 90th
 *     percentile) and the median priority fee, from eth_feeHistory;
 *   - for a rollup, the L1 data fee of a real-sized signed anchor and copy,
 *     from the chain's own oracle (GasPriceOracle.getL1Fee on Base and OP
 *     Mainnet, NodeInterface.gasEstimateL1Component on Arbitrum);
 *   - the gas of each write, from contracts/snapshots (equal to a receipt's
 *     gasUsed on Anvil);
 *   - how many seconds the finalized block trails the latest one, now;
 *   - ETH in EUR, from CoinGecko.
 *
 * Endpoints default to publicnode.com; MEASURE_RPC_<MAINNET|BASE|OPTIMISM|ARBITRUM> overrides one.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createPublicClient, encodeFunctionData, formatEther, http, keccak256, parseAbi, serializeTransaction, toHex, type Chain, type Hex, type PublicClient } from 'viem';
import { arbitrum, base, mainnet, optimism } from 'viem/chains';
import { registryAbi } from '../src/lib/chain/registry-artifact';

const FEE_BLOCKS = 1024;
const ROOT = path.resolve(import.meta.dirname, '..');
const gas = JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts', 'snapshots', 'AuditReportRegistryGasTest.json'), 'utf8')) as Record<string, string>;
const ANCHOR_GAS = BigInt(gas.anchor_v1);
const COPY_GAS = BigInt(gas.anchor_distribution_copy);
const REVOKE_GAS = BigInt(gas.revoke);

const CANDIDATES: { key: string; chain: Chain; rpc: string; rollup: 'op' | 'arbitrum' | null }[] = [
  { key: 'MAINNET', chain: mainnet, rpc: 'https://ethereum-rpc.publicnode.com', rollup: null },
  { key: 'BASE', chain: base, rpc: 'https://base-rpc.publicnode.com', rollup: 'op' },
  { key: 'OPTIMISM', chain: optimism, rpc: 'https://optimism-rpc.publicnode.com', rollup: 'op' },
  { key: 'ARBITRUM', chain: arbitrum, rpc: 'https://arbitrum-one-rpc.publicnode.com', rollup: 'arbitrum' },
];

const GAS_PRICE_ORACLE = '0x420000000000000000000000000000000000000F';
const NODE_INTERFACE = '0x00000000000000000000000000000000000000C8';
const opOracleAbi = parseAbi(['function getL1Fee(bytes _data) view returns (uint256)']);
const nodeInterfaceAbi = parseAbi(['function gasEstimateL1Component(address to, bool contractCreation, bytes data) payable returns (uint64 gasEstimateForL1, uint256 baseFee, uint256 l1BaseFeeEstimate)']);

const random32 = () => keccak256(toHex(crypto.getRandomValues(new Uint8Array(32))));
const REGISTRY = '0x87ba96d1d48e280429a8ead1059334c34507c31f';

/** A signed-sized transaction carrying the call: random hashes, as real commitments are, so nothing compresses away. */
function signedSized(chainId: number, data: Hex, gasLimit: bigint): Hex {
  return serializeTransaction(
    { type: 'eip1559', chainId, nonce: 1000, to: REGISTRY, data, gas: gasLimit, maxFeePerGas: 10n ** 9n, maxPriorityFeePerGas: 10n ** 6n, value: 0n },
    { r: random32(), s: random32(), yParity: 0 },
  );
}

const anchorData = () => encodeFunctionData({ abi: registryAbi, functionName: 'anchor', args: [random32(), 1, `0x${'0'.repeat(64)}`, random32(), random32(), random32()] });
const copyData = () => encodeFunctionData({ abi: registryAbi, functionName: 'anchorDistributionCopy', args: [random32(), random32()] });

const percentile = (values: bigint[], p: number) => {
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};

async function l1Fee(client: PublicClient, rollup: 'op' | 'arbitrum' | null, chainId: number, data: Hex, gasLimit: bigint): Promise<bigint> {
  if (rollup === 'op') return client.readContract({ address: GAS_PRICE_ORACLE, abi: opOracleAbi, functionName: 'getL1Fee', args: [signedSized(chainId, data, gasLimit)] });
  if (rollup === 'arbitrum') {
    const { result } = await client.simulateContract({ address: NODE_INTERFACE, abi: nodeInterfaceAbi, functionName: 'gasEstimateL1Component', args: [REGISTRY, false, data] });
    const [gasForL1, baseFee] = result;
    return BigInt(gasForL1) * baseFee;
  }
  return 0n;
}

async function measure(candidate: (typeof CANDIDATES)[number]) {
  const rpc = process.env[`MEASURE_RPC_${candidate.key}`] || candidate.rpc;
  const client = createPublicClient({ chain: candidate.chain, transport: http(rpc, { timeout: 30_000 }) }) as PublicClient;
  const [latest, finalized, history] = await Promise.all([
    client.getBlock({ blockTag: 'latest' }),
    client.getBlock({ blockTag: 'finalized' }),
    client.getFeeHistory({ blockCount: FEE_BLOCKS, rewardPercentiles: [50], blockTag: 'latest' }),
  ]);
  const baseFees = history.baseFeePerGas.slice(0, -1);
  const priority = percentile((history.reward ?? []).map((r) => r[0]), 50);
  const price = (p: number) => percentile(baseFees, p) + priority;
  const [anchorL1, copyL1] = await Promise.all([l1Fee(client, candidate.rollup, candidate.chain.id, anchorData(), ANCHOR_GAS), l1Fee(client, candidate.rollup, candidate.chain.id, copyData(), COPY_GAS)]);
  const report = (p: number) => (ANCHOR_GAS + COPY_GAS) * price(p) + anchorL1 + copyL1;
  return {
    chain: candidate.chain.name,
    chainId: candidate.chain.id,
    endpoint: new URL(rpc).host,
    latestBlock: Number(latest.number),
    blocksSampled: baseFees.length,
    baseFeeGweiMedian: Number(percentile(baseFees, 50)) / 1e9,
    baseFeeGweiP90: Number(percentile(baseFees, 90)) / 1e9,
    priorityFeeGweiMedian: Number(priority) / 1e9,
    l1FeeEthAnchor: formatEther(anchorL1),
    l1FeeEthCopy: formatEther(copyL1),
    reportEthMedian: formatEther(report(50)),
    reportEthP90: formatEther(report(90)),
    revokeEthMedian: formatEther(REVOKE_GAS * price(50) + (candidate.rollup ? copyL1 : 0n)),
    finalizedLagSeconds: Number(latest.timestamp - finalized.timestamp),
  };
}

async function main() {
  const measuredAt = new Date().toISOString();
  const [prices, ...results] = await Promise.all([
    fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=eur,usd').then((r) => r.json() as Promise<{ ethereum: { eur: number; usd: number } }>),
    ...CANDIDATES.map(measure),
  ]);
  const eur = (eth: string) => (Number(eth) * prices.ethereum.eur).toFixed(Number(eth) * prices.ethereum.eur < 0.1 ? 4 : 2);
  console.log(`Measured ${measuredAt}; ETH = EUR ${prices.ethereum.eur} (CoinGecko). One report = an anchor (${ANCHOR_GAS} gas) and its copy (${COPY_GAS} gas).\n`);
  console.log('| Chain | Base fee, median / p90 (gwei) | L1 data fee, anchor + copy (ETH) | One report, median (EUR) | One report, p90 (EUR) | A revocation (EUR) | Finalized trails latest |');
  console.log('| --- | --- | --- | --- | --- | --- | --- |');
  for (const r of results) {
    console.log(
      `| ${r.chain} | ${r.baseFeeGweiMedian.toPrecision(3)} / ${r.baseFeeGweiP90.toPrecision(3)} | ${(Number(r.l1FeeEthAnchor) + Number(r.l1FeeEthCopy)).toPrecision(3)} | ${eur(r.reportEthMedian)} | ${eur(r.reportEthP90)} | ${eur(r.revokeEthMedian)} | ${Math.round(r.finalizedLagSeconds / 60)} min |`,
    );
  }
  console.log(`\n${JSON.stringify({ measuredAt, ethEur: prices.ethereum.eur, ethUsd: prices.ethereum.usd, gas: { anchor: Number(ANCHOR_GAS), copy: Number(COPY_GAS), revoke: Number(REVOKE_GAS) }, results }, null, 2)}`);
}

main().catch((error) => {
  console.error(JSON.stringify({ level: 'error', message: 'measurement failed', error: error instanceof Error ? error.message : String(error) }));
  process.exit(1);
});
