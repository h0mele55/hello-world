/**
 * The two Bitcoin block explorers a proof's block is read from (#66), run by
 * different operators. A module of its own, with no imports, so the proxy can
 * name their origins in the verifier's CSP without loading the checking code.
 */
export const BITCOIN_EXPLORERS = ['https://blockstream.info/api', 'https://mempool.space/api'] as const;

/** Their origins, for a CSP's connect-src. */
export const EXPLORER_ORIGINS: readonly string[] = BITCOIN_EXPLORERS.map((url) => new URL(url).origin);
