/** The four forms of auditor's opinion in ISA 700 (revised) and ISA 705. */
export const OPINION_TYPES = ['UNMODIFIED', 'QUALIFIED', 'ADVERSE', 'DISCLAIMER'] as const;
export type OpinionType = (typeof OPINION_TYPES)[number];

export const LANGUAGES = ['en', 'bg'] as const;
export type Language = (typeof LANGUAGES)[number];
