/** Block explorer links, so a reader can check an anchor by hand. None for a local chain. */
const EXPLORERS: Record<number, string> = { 11155111: 'https://sepolia.etherscan.io' };

export const explorerTxUrl = (chainId: number, txHash: string) => (EXPLORERS[chainId] ? `${EXPLORERS[chainId]}/tx/${txHash}` : null);
export const explorerAddressUrl = (chainId: number, address: string) => (EXPLORERS[chainId] ? `${EXPLORERS[chainId]}/address/${address}` : null);

const NETWORK_NAMES: Record<number, string> = { 11155111: 'Ethereum Sepolia', 31337: 'Local test chain (Anvil)' };

/** How a chain is named to a person reading a certificate. */
export const networkNameOf = (chainId: number) => NETWORK_NAMES[chainId] ?? `Chain ${chainId}`;
