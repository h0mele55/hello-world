import { checkSeal, sealPdf, type SealCheck } from './pades';
import type { SealSigner, Timestamper } from './types';

/**
 * The seal on a distribution copy (#70), as the worker applies it: the stamped
 * copy sealed, then checked against the roots the firm configured before it is
 * stored or anchored. A seal that does not check is never kept.
 */

export interface CopySeal {
  signer: SealSigner;
  timestamper: Timestamper;
  /** The roots the seal must chain to: the trust service provider's, as the firm configured them. */
  trustAnchors: Uint8Array[];
}

/** Shown by PDF readers as the reason for the seal. */
export const COPY_SEAL_REASON = 'Distribution copy of an anchored audit report';

export async function sealStampedCopy(stamped: Uint8Array, seal: CopySeal, now: Date): Promise<{ sealed: Uint8Array; check: SealCheck }> {
  const sealed = await sealPdf(stamped, { signer: seal.signer, timestamper: seal.timestamper, signingTime: now, reason: COPY_SEAL_REASON });
  return { sealed, check: await checkSeal(sealed, seal.trustAnchors, stamped) };
}
