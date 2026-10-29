import { addValidationData, type LongTermOptions } from './long-term';
import { checkSeal, sealPdf, type SealCheck } from './pades';
import { SealError, type SealSigner, type Timestamper } from './types';

/**
 * The seal on a distribution copy (#70), as the worker applies it: the stamped
 * copy sealed, then checked against the roots the firm configured before it is
 * stored or anchored. A seal that does not check is never kept. At B-LT
 * (#119) the copy also carries its certificates' status, fetched and checked
 * once the seal itself has checked, and is checked again as a whole.
 */

export type SealLevel = 'B-T' | 'B-LT';

export interface CopySeal {
  signer: SealSigner;
  timestamper: Timestamper;
  /** The roots the seal must chain to: the trust service provider's, as the firm configured them. */
  trustAnchors: Uint8Array[];
  /** PAdES baseline level; B-T unless given. */
  level?: SealLevel;
  /** How a B-LT copy's statuses are fetched (tests give their own `fetch`). */
  longTerm?: LongTermOptions;
}

/** Shown by PDF readers as the reason for the seal. */
export const COPY_SEAL_REASON = 'Distribution copy of an anchored audit report';

export async function sealStampedCopy(stamped: Uint8Array, seal: CopySeal, now: Date): Promise<{ sealed: Uint8Array; check: SealCheck }> {
  const sealed = await sealPdf(stamped, { signer: seal.signer, timestamper: seal.timestamper, signingTime: now, reason: COPY_SEAL_REASON });
  const check = await checkSeal(sealed, seal.trustAnchors, stamped);
  if (seal.level !== 'B-LT') return { sealed, check };
  const longTerm = await addValidationData(sealed, seal.trustAnchors, seal.longTerm);
  const checked = await checkSeal(longTerm, seal.trustAnchors, stamped);
  if (!checked.longTerm) throw new SealError('REVOCATION_REFUSED', 'the copy does not carry its validation data');
  return { sealed: longTerm, check: checked };
}
