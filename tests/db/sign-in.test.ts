import { PrismaPg } from '@prisma/adapter-pg';
import bcrypt from 'bcryptjs';
import { generate } from 'otplib';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { authOptions, MFA_CODE_REQUIRED, type SessionUser } from '@/auth';
import { PrismaClient } from '@/generated/prisma/client';
import { resetThrottle } from '@/lib/login-throttle';
import { confirmMfaSetup, startMfaSetup } from '@/lib/mfa';

/**
 * The real `authorize` of the sign-in provider (#150): many attempts for one
 * email sent at once must not get more guesses than the lockout allows.
 */
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });

type Authorize = (credentials: Record<string, string>, req: { headers: Record<string, string> }) => Promise<{ id: string } | null>;
const authorize = (authOptions.providers[0] as unknown as { options: { authorize: Authorize } }).options.authorize;

/** What one attempt came to: signed in, refused, or the code asked for. */
async function attempt(credentials: Record<string, string>): Promise<'SIGNED_IN' | 'REFUSED' | string> {
  return authorize(credentials, { headers: {} }).then(
    (user) => (user ? 'SIGNED_IN' : 'REFUSED'),
    (e: unknown) => (e instanceof Error ? e.message : String(e)),
  );
}

const PASSWORD = 'the right password';
let orgId: string;
const codeAt = (secret: string, seconds: number) => generate({ secret, epoch: seconds });
const now = () => Math.floor(Date.now() / 1000);

async function make(email: string, role: SessionUser['role']): Promise<SessionUser> {
  const user = await prisma.user.create({ data: { orgId, email, name: email, role, passwordHash: await bcrypt.hash(PASSWORD, 4) } });
  return { id: user.id, email, name: email, role, orgId, mfa: 'ENROLL' };
}

beforeEach(async () => {
  resetThrottle();
  await prisma.$executeRawUnsafe('TRUNCATE "RecoveryCode", "ChainWrite", "AuditEvent", "ReportVersion", "StoredFile", "Engagement", "Client", "User", "IssuerOrg" CASCADE');
  orgId = (await prisma.issuerOrg.create({ data: { name: 'Example Audit OOD' } })).id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('concurrent password attempts', () => {
  it('refuses the right password sent at once with 49 wrong ones', async () => {
    await make('preparer@example.test', 'PREPARER');
    const guesses = [...Array.from({ length: 49 }, (_, i) => `wrong ${i}`), PASSWORD];
    const results = await Promise.all(guesses.map((password) => attempt({ email: 'preparer@example.test', password })));
    expect(results.filter((r) => r !== 'REFUSED')).toEqual([]);
  });

  it('checks a second attempt for the same email after the first, so the right password sent with a wrong one signs in', async () => {
    await make('preparer@example.test', 'PREPARER');
    const results = await Promise.all([attempt({ email: 'Preparer@example.test', password: 'wrong' }), attempt({ email: 'preparer@example.test', password: PASSWORD })]);
    expect(results).toEqual(['REFUSED', 'SIGNED_IN']);
  });

  it('holds an attempt that waited to the lockout the ones before it reached', async () => {
    await make('preparer@example.test', 'PREPARER');
    for (let i = 0; i < 4; i++) expect(await attempt({ email: 'preparer@example.test', password: `wrong ${i}` })).toBe('REFUSED');
    // The fifth failure is being checked when the right password arrives: it waits, then finds the account locked.
    const results = await Promise.all([attempt({ email: 'preparer@example.test', password: 'wrong 4' }), attempt({ email: 'preparer@example.test', password: PASSWORD })]);
    expect(results).toEqual(['REFUSED', 'REFUSED']);
  });

  it('counts each guess before it is checked, so five wrong ones lock the account', async () => {
    await make('preparer@example.test', 'PREPARER');
    for (let i = 0; i < 5; i++) expect(await attempt({ email: 'preparer@example.test', password: `wrong ${i}` })).toBe('REFUSED');
    expect(await attempt({ email: 'preparer@example.test', password: PASSWORD })).toBe('REFUSED');
  });
});

describe('concurrent second-factor attempts', () => {
  async function enrolled() {
    const admin = await make('admin@example.test', 'ADMIN');
    const { secret } = await startMfaSetup(admin);
    await confirmMfaSetup(admin, await codeAt(secret, now() - 30));
    return secret;
  }

  it('refuses the right code sent at once with 49 wrong ones', async () => {
    const secret = await enrolled();
    const right = await codeAt(secret, now());
    const codes = [...Array.from({ length: 49 }, (_, i) => String(i).padStart(6, '0')).filter((c) => c !== right), right];
    const results = await Promise.all(codes.map((otp) => attempt({ email: 'admin@example.test', password: PASSWORD, otp })));
    expect(results.filter((r) => r !== 'REFUSED')).toEqual([]);
  });

  it('checks a second code for the same email after the first, each held to the lockout', async () => {
    const secret = await enrolled();
    const right = await codeAt(secret, now());
    const wrong = right === '000000' ? '111111' : '000000';
    const results = await Promise.all([
      attempt({ email: 'admin@example.test', password: PASSWORD, otp: wrong }),
      attempt({ email: 'admin@example.test', password: PASSWORD, otp: right }),
    ]);
    expect(results).toEqual(['REFUSED', 'SIGNED_IN']);
  });

  it('does not count asking for the code as a failure, and clears the count on success', async () => {
    const secret = await enrolled();
    for (let i = 0; i < 6; i++) expect(await attempt({ email: 'admin@example.test', password: PASSWORD })).toBe(MFA_CODE_REQUIRED);
    expect(await attempt({ email: 'admin@example.test', password: PASSWORD, otp: await codeAt(secret, now()) })).toBe('SIGNED_IN');
  });
});
