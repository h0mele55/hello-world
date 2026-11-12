import { PrismaPg } from '@prisma/adapter-pg';
import bcrypt from 'bcryptjs';
import { generate } from 'otplib';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { authOptions, liveUser, SESSION_MAX_AGE_MS, type SessionUser } from '@/auth';
import { PrismaClient } from '@/generated/prisma/client';
import { verifyAuditChain } from '@/lib/audit';
import { resetThrottle } from '@/lib/login-throttle';
import { confirmMfaSetup, startMfaSetup } from '@/lib/mfa';
import { listTeam, resetSecondFactor, setUserDisabled } from '@/lib/team';

/**
 * Sessions that end (#145): every session carries its user's sessionVersion
 * and the time it signed in, and is refused once the version moves, the user
 * is disabled, or eight hours have passed. An admin resets another person's
 * second factor, or disables them; never their own.
 */
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
const PASSWORD = 'the right password';
let orgId: string;

async function make(email: string, role: SessionUser['role'], firm = orgId): Promise<SessionUser> {
  const user = await prisma.user.create({ data: { orgId: firm, email, name: email, role, passwordHash: await bcrypt.hash(PASSWORD, 4) } });
  return { id: user.id, email, name: email, role, orgId: firm, mfa: role === 'APPROVER' || role === 'ADMIN' ? 'VERIFIED' : 'NOT_REQUIRED' };
}
/** A session as sign-in leaves it: the user's version now, signed in `ago` milliseconds back. */
async function sessionOf(user: SessionUser, ago = 0) {
  const { sessionVersion } = await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { sessionVersion: true } });
  return { user, sv: sessionVersion, signedInAt: Date.now() - ago };
}

type Authorize = (credentials: Record<string, string>, req: { headers: Record<string, string> }) => Promise<{ id: string } | null>;
const authorize = (authOptions.providers[0] as unknown as { options: { authorize: Authorize } }).options.authorize;
const codeOf = (promise: Promise<unknown>) => promise.then(() => null, (e: { code?: string }) => e.code ?? String(e));

beforeEach(async () => {
  resetThrottle();
  await prisma.$executeRawUnsafe('TRUNCATE "RecoveryCode", "ChainWrite", "AuditEvent", "ReportVersion", "StoredFile", "Engagement", "Client", "User", "IssuerOrg" CASCADE');
  orgId = (await prisma.issuerOrg.create({ data: { name: 'Example Audit OOD' } })).id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('a session (#145)', () => {
  it('stands while its user is as it signed in, and for eight hours at most', async () => {
    const approver = await make('approver@example.test', 'APPROVER');
    expect(await liveUser(await sessionOf(approver))).toEqual(approver);
    expect(await liveUser(await sessionOf(approver, SESSION_MAX_AGE_MS - 60_000))).toEqual(approver);
    // However often the cookie was re-issued since.
    expect(await liveUser(await sessionOf(approver, SESSION_MAX_AGE_MS + 1))).toBeNull();
    // A session from before sessions carried a version, or the time it signed in.
    expect(await liveUser({ user: approver })).toBeNull();
    expect(await liveUser({ user: approver, sv: 0 })).toBeNull();
  });

  it('ends once its user’s version moves, their role or firm changes, or they are disabled', async () => {
    const approver = await make('approver@example.test', 'APPROVER');
    const session = await sessionOf(approver);
    await prisma.user.update({ where: { id: approver.id }, data: { role: 'ADMIN' } });
    expect(await liveUser(session)).toBeNull();
    await prisma.user.update({ where: { id: approver.id }, data: { role: 'APPROVER', sessionVersion: { increment: 1 } } });
    expect(await liveUser(session)).toBeNull();
    expect(await liveUser(await sessionOf(approver))).toEqual(approver);
    await prisma.user.update({ where: { id: approver.id }, data: { disabledAt: new Date() } });
    expect(await liveUser(await sessionOf(approver))).toBeNull();
  });

  it('ends when the second factor is set up, so the next one signs in with it', async () => {
    const admin = await make('admin@example.test', 'ADMIN');
    const enrolling = await sessionOf({ ...admin, mfa: 'ENROLL' });
    const { secret } = await startMfaSetup(enrolling.user);
    await confirmMfaSetup(enrolling.user, await generate({ secret, epoch: Math.floor(Date.now() / 1000) }));
    expect(await liveUser(enrolling)).toBeNull();
  });
});

describe('an admin and the firm’s people (#145)', () => {
  it('resets another person’s second factor: secret and codes gone, sessions ended, set up afresh at the next sign-in', async () => {
    const admin = await make('admin@example.test', 'ADMIN');
    const approver = await make('approver@example.test', 'APPROVER');
    const { secret } = await startMfaSetup({ ...approver, mfa: 'ENROLL' });
    await confirmMfaSetup({ ...approver, mfa: 'ENROLL' }, await generate({ secret, epoch: Math.floor(Date.now() / 1000) - 30 }));
    const session = await sessionOf(approver);
    expect((await listTeam(admin)).find((m) => m.id === approver.id)).toMatchObject({ mfa: 'ENABLED', disabledAt: null });

    await resetSecondFactor(admin, approver.id);
    expect(await prisma.user.findUniqueOrThrow({ where: { id: approver.id } })).toMatchObject({ totpSecret: null, totpEnabledAt: null, totpLastStep: null, totpPendingSecret: null });
    expect(await prisma.recoveryCode.count({ where: { userId: approver.id } })).toBe(0);
    expect(await liveUser(session)).toBeNull();
    expect((await listTeam(admin)).find((m) => m.id === approver.id)).toMatchObject({ mfa: 'NOT_SET_UP' });
    // The password alone now signs in to set it up again, and nothing else.
    expect(await authorize({ email: approver.email, password: PASSWORD }, { headers: {} })).toMatchObject({ mfa: 'ENROLL' });
    expect(await prisma.auditEvent.findFirstOrThrow({ where: { action: 'mfa.reset' } })).toMatchObject({ actorId: admin.id, subjectId: approver.id });
    expect(await verifyAuditChain(prisma, orgId)).toMatchObject({ ok: true });
  });

  it('disables another person, ending their sessions and refusing their sign-in, and enables them again', async () => {
    const admin = await make('admin@example.test', 'ADMIN');
    const preparer = await make('preparer@example.test', 'PREPARER');
    const session = await sessionOf(preparer);
    await setUserDisabled(admin, preparer.id, true);
    expect(await liveUser(session)).toBeNull();
    expect(await authorize({ email: preparer.email, password: PASSWORD }, { headers: {} })).toBeNull();
    // Disabling again records nothing more.
    await setUserDisabled(admin, preparer.id, true);
    await setUserDisabled(admin, preparer.id, false);
    expect(await authorize({ email: preparer.email, password: PASSWORD }, { headers: {} })).toMatchObject({ id: preparer.id });
    // The old session stays ended: enabling does not bring it back.
    expect(await liveUser(session)).toBeNull();
    const actions = (await prisma.auditEvent.findMany({ where: { subjectId: preparer.id }, orderBy: { seq: 'asc' } })).map((e) => e.action);
    expect(actions).toEqual(['user.disabled', 'user.enabled']);
  });

  it('is never done by an admin to themselves, by anyone but an admin, or to another firm’s person', async () => {
    const admin = await make('admin@example.test', 'ADMIN');
    const other = await make('admin2@example.test', 'ADMIN');
    const approver = await make('approver@example.test', 'APPROVER');
    const viewer = await make('viewer@example.test', 'VIEWER');
    const elsewhere = await make('admin@another.test', 'ADMIN', (await prisma.issuerOrg.create({ data: { name: 'Another Firm' } })).id);
    expect(await codeOf(resetSecondFactor(admin, admin.id))).toBe('FORBIDDEN');
    expect(await codeOf(setUserDisabled(admin, admin.id, true))).toBe('FORBIDDEN');
    expect(await codeOf(resetSecondFactor(approver, other.id))).toBe('FORBIDDEN');
    expect(await codeOf(listTeam(approver))).toBe('FORBIDDEN');
    expect(await codeOf(resetSecondFactor(admin, elsewhere.id))).toBe('NOT_FOUND');
    expect(await codeOf(setUserDisabled(admin, elsewhere.id, true))).toBe('NOT_FOUND');
    // A role that signs in without a second factor has none to reset.
    expect(await codeOf(resetSecondFactor(admin, viewer.id))).toBe('FORBIDDEN');
    // Another admin can do it for them.
    await expect(resetSecondFactor(other, admin.id)).resolves.toEqual({ userId: admin.id });
    expect((await listTeam(admin)).map((m) => m.email)).not.toContain('admin@another.test');
  });
});
