import type { Role } from '@/generated/prisma/enums';

/**
 * Who may do what (Phase 5). One table, read by the route handlers before
 * anything else runs and again by the use cases, so a route and the use case
 * behind it cannot disagree. A VIEWER reads and does nothing else.
 */
export const ROLES = ['ADMIN', 'PREPARER', 'APPROVER', 'VIEWER'] as const satisfies readonly Role[];

export const CAN = {
  /** Create an engagement, upload a version, confirm its opinion, discard a draft. */
  prepare: ['PREPARER'],
  /** Approve an anchor or a revocation (four-eyes, rule 6), reject a revocation, and queue a failed copy again. */
  approve: ['APPROVER'],
  /** Ask for an anchored version to be revoked, or take that request back. */
  requestRevocation: ['ADMIN'],
  /** Move the firm's chain write mode. */
  setChainMode: ['APPROVER', 'ADMIN'],
  /** Set up a second factor: the roles that must sign in with one. */
  setUpMfa: ['APPROVER', 'ADMIN'],
} as const satisfies Record<string, readonly Role[]>;

export type Act = keyof typeof CAN;

/** These roles sign in with a second factor; until they have one, they can only set it up. */
export const MFA_ROLES: readonly Role[] = CAN.setUpMfa;

/**
 * Where a session stands on the second factor: not needed for its role,
 * still to be set up (the session can do nothing else), or verified at sign-in.
 */
export type MfaState = 'NOT_REQUIRED' | 'ENROLL' | 'VERIFIED';

export class AccessError extends Error {
  constructor(
    readonly code: 'FORBIDDEN' | 'MFA_REQUIRED',
    readonly detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'AccessError';
  }
}

export const mayDo = (role: Role, act: Act): boolean => (CAN[act] as readonly Role[]).includes(role);

export function requireRole(user: { role: Role }, act: Act): void {
  if (!mayDo(user.role, act)) throw new AccessError('FORBIDDEN', `only ${CAN[act].join(' or ').toLowerCase()} may do this`);
}
