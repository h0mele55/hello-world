import type { ChainWriteMode } from '@/generated/prisma/enums';

/** Inflect's write ladder. Widening moves one rung at a time; narrowing is a brake and may jump. */
export const MODE_LADDER = ['DISABLED', 'DRY_RUN', 'LIVE'] as const satisfies readonly ChainWriteMode[];

export const rungOf = (mode: ChainWriteMode) => MODE_LADDER.indexOf(mode);
