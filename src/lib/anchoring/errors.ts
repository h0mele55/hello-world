/** Named refusals of the anchoring use cases (CLAUDE.md rule 7). */
export type AnchoringErrorCode =
  | 'NOT_FOUND'
  | 'NOT_CONFIRMED'
  | 'FOUR_EYES'
  | 'CHAIN_WRITES_DISABLED'
  | 'CHAIN_NOT_CONFIGURED'
  | 'PREDECESSOR_NOT_ANCHORED'
  | 'ALREADY_QUEUED'
  | 'MODE_UNCHANGED'
  | 'MODE_SKIPS_RUNG'
  | 'NOT_ANCHORED'
  | 'ANCHOR_ONLY'
  | 'NOT_COMPLETE'
  | 'NOT_REVOCABLE'
  | 'CONFIRMATION_MISMATCH'
  | 'REVOCATION_OPEN'
  | 'NOT_REQUESTED'
  | 'COPY_IN_FLIGHT';

export class AnchoringError extends Error {
  constructor(
    readonly code: AnchoringErrorCode,
    readonly detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'AnchoringError';
  }
}
