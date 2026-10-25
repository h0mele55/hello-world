/** Block explorer links, so a reader can check an anchor by hand. None for a local chain. */
const EXPLORERS: Record<number, string> = {
  1: 'https://etherscan.io',
  11155111: 'https://sepolia.etherscan.io',
  8453: 'https://basescan.org',
  84532: 'https://sepolia.basescan.org',
  10: 'https://optimistic.etherscan.io',
  11155420: 'https://sepolia-optimism.etherscan.io',
  42161: 'https://arbiscan.io',
  421614: 'https://sepolia.arbiscan.io',
};

export const explorerTxUrl = (chainId: number, txHash: string) => (EXPLORERS[chainId] ? `${EXPLORERS[chainId]}/tx/${txHash}` : null);
export const explorerBlockUrl = (chainId: number, block: number | bigint) => (EXPLORERS[chainId] ? `${EXPLORERS[chainId]}/block/${block}` : null);
export const explorerAddressUrl = (chainId: number, address: string) => (EXPLORERS[chainId] ? `${EXPLORERS[chainId]}/address/${address}` : null);

const NETWORK_NAMES: Record<number, string> = {
  1: 'Ethereum',
  11155111: 'Ethereum Sepolia',
  8453: 'Base',
  84532: 'Base Sepolia',
  10: 'OP Mainnet',
  11155420: 'OP Sepolia',
  42161: 'Arbitrum One',
  421614: 'Arbitrum Sepolia',
  31337: 'Local test chain (Anvil)',
};

/** How a chain is named to a person reading a certificate. */
export const networkNameOf = (chainId: number) => NETWORK_NAMES[chainId] ?? `Chain ${chainId}`;
