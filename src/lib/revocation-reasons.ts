import type { RevocationReason } from '@/generated/prisma/enums';

/**
 * A revocation's reason as the registry records it (`revokeReason`, a uint8;
 * zero is refused by the contract). The numbers are fixed: a verifier reads
 * them from records already on chain.
 */
export const REVOCATION_CODES = {
  WITHDRAWN: 1,
  ISSUED_IN_ERROR: 2,
  SUPERSEDED_AND_WITHDRAWN: 3,
  OTHER: 9,
} as const satisfies Record<RevocationReason, number>;

export const REVOCATION_REASONS = Object.keys(REVOCATION_CODES) as RevocationReason[];
