/** Block explorer links, so a reader can check an anchor by hand. None for a local chain. */
const EXPLORERS: Record<number, string> = { 11155111: 'https://sepolia.etherscan.io' };

export const explorerTxUrl = (chainId: number, txHash: string) => (EXPLORERS[chainId] ? `${EXPLORERS[chainId]}/tx/${txHash}` : null);
export const explorerAddressUrl = (chainId: number, address: string) => (EXPLORERS[chainId] ? `${EXPLORERS[chainId]}/address/${address}` : null);
