import 'server-only';
import type { SessionUser } from '@/auth';
import type { Role } from '@/generated/prisma/enums';
import { appendAuditEvent } from '@/lib/audit';
import { db } from '@/lib/db';
import { IntakeError } from '@/lib/reports/intake';
import { AccessError, MFA_ROLES, requireRole } from '@/lib/roles';

/**
 * The firm's people, as an admin manages them (#145). An admin can reset
 * another person's second factor (a lost or stolen authenticator) and disable
 * or enable another person; never their own, so one admin cannot quietly
 * remove the check on themselves. Each change bumps the person's
 * sessionVersion, so every session they hold ends at its next request, and is
 * written to the audit log in the same transaction.
 */

export interface TeamMember {
  id: string;
  name: string;
  email: string;
  role: Role;
  /** Whether the role signs in with a second factor, and whether it is set up. */
  mfa: 'NOT_REQUIRED' | 'ENABLED' | 'NOT_SET_UP';
  disabledAt: string | null;
}

export async function listTeam(admin: SessionUser): Promise<TeamMember[]> {
  requireRole(admin, 'manageUsers');
  const users = await db().user.findMany({
    where: { orgId: admin.orgId },
    select: { id: true, name: true, email: true, role: true, totpEnabledAt: true, disabledAt: true },
    orderBy: [{ role: 'asc' }, { email: 'asc' }],
    take: 500,
  });
  return users.map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    mfa: !MFA_ROLES.includes(u.role) ? 'NOT_REQUIRED' : u.totpEnabledAt ? 'ENABLED' : 'NOT_SET_UP',
    disabledAt: u.disabledAt?.toISOString() ?? null,
  }));
}

/** Another person of the firm, never the admin; another firm's is NOT_FOUND. */
async function memberOf(admin: SessionUser, userId: string) {
  requireRole(admin, 'manageUsers');
  if (userId === admin.id) throw new AccessError('FORBIDDEN', 'an admin cannot do this to their own account; another admin must');
  const target = await db().user.findFirst({ where: { id: userId, orgId: admin.orgId }, select: { id: true, role: true } });
  // Another firm's person is not found, never forbidden (CLAUDE.md).
  if (!target) throw new IntakeError('NOT_FOUND');
  return target;
}

/**
 * Clears another person's second factor and recovery codes: they set it up
 * afresh at their next sign-in, with their password. Their sessions end now.
 */
export async function resetSecondFactor(admin: SessionUser, userId: string): Promise<{ userId: string }> {
  const target = await memberOf(admin, userId);
  if (!MFA_ROLES.includes(target.role)) throw new AccessError('FORBIDDEN', 'this role signs in without a second factor');
  await db().$transaction(async (tx) => {
    await tx.user.update({
      where: { id: target.id },
      data: { totpSecret: null, totpEnabledAt: null, totpLastStep: null, totpPendingSecret: null, sessionVersion: { increment: 1 } },
    });
    const { count } = await tx.recoveryCode.deleteMany({ where: { userId: target.id } });
    await appendAuditEvent(tx, { orgId: admin.orgId, actorId: admin.id, action: 'mfa.reset', subjectType: 'User', subjectId: target.id, data: { recoveryCodesRemoved: count } });
  });
  return { userId: target.id };
}

/** Disables or enables another person. Disabling ends their sessions and refuses their sign-in. */
export async function setUserDisabled(admin: SessionUser, userId: string, disabled: boolean): Promise<{ userId: string; disabled: boolean }> {
  const target = await memberOf(admin, userId);
  await db().$transaction(async (tx) => {
    const { count } = await tx.user.updateMany({
      where: { id: target.id, disabledAt: disabled ? null : { not: null } },
      data: disabled ? { disabledAt: new Date(), sessionVersion: { increment: 1 } } : { disabledAt: null },
    });
    // Already as asked: nothing to record.
    if (count === 0) return;
    await appendAuditEvent(tx, { orgId: admin.orgId, actorId: admin.id, action: disabled ? 'user.disabled' : 'user.enabled', subjectType: 'User', subjectId: target.id, data: {} });
  });
  return { userId: target.id, disabled };
}
