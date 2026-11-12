import 'server-only';
import bcrypt from 'bcryptjs';
import type { NextAuthOptions } from 'next-auth';
import { getServerSession } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import { z } from 'zod';
import type { Role } from '@/generated/prisma/enums';
import { db } from '@/lib/db';
import { beginSignIn } from '@/lib/login-throttle';
import { verifySecondFactor } from '@/lib/mfa';
import { clientAddressOf } from '@/lib/rate-limit';
import { MFA_ROLES, type MfaState } from '@/lib/roles';
import { serverEnv } from '@/lib/server-env';

declare module 'next-auth' {
  interface Session {
    user: SessionUser;
    /** The user's sessionVersion when this session signed in, and when it did (ms), checked on every request (#145). */
    sv?: number;
    signedInAt?: number;
  }
  interface User {
    role: Role;
    orgId: string;
    mfa: MfaState;
    sessionVersion: number;
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    uid?: string;
    role?: Role;
    orgId?: string;
    mfa?: MfaState;
    sv?: number;
    signedInAt?: number;
  }
}

/**
 * A session's absolute lifetime, from sign-in (#145). NextAuth slides the
 * cookie's expiry forward on every read of the session, so its maxAge alone
 * would let one cookie live for ever.
 */
export const SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1000;

const Login = z.object({ email: z.email().max(254), password: z.string().min(1).max(200), otp: z.string().trim().max(32).optional() });

/**
 * Thrown by authorize once the password is right but the account needs its
 * second factor: the sign-in form then asks for the code. NextAuth passes the
 * message to the client as the error.
 */
export const MFA_CODE_REQUIRED = 'MFA_CODE_REQUIRED';

// bcrypt (cost 12) of a throwaway password. Compared against when the email
// is unknown or throttled, so those cost the same time as a wrong password.
const DUMMY_HASH = '$2b$12$HF3bmoNwXpWglqk.nekn0.LB9Lb35S6ZeqYslr4LLWc60/AZHo68u';

export const authOptions: NextAuthOptions = {
  secret: process.env.NEXTAUTH_SECRET,
  session: { strategy: 'jwt', maxAge: 8 * 60 * 60 },
  pages: { signIn: '/login' },
  providers: [
    Credentials({
      name: 'Email and password',
      credentials: { email: { type: 'email' }, password: { type: 'password' }, otp: { type: 'text' } },
      async authorize(credentials, req) {
        serverEnv();
        const parsed = Login.safeParse(credentials);
        if (!parsed.success) return null;
        const { email, password } = parsed.data;
        // In line for this email before anything else is awaited (#150), and counted as a failure once its turn comes;
        // only success or asking for the code takes that back.
        const attempt = await beginSignIn(email, clientAddressOf(req?.headers));
        try {
          if (!attempt.ok) {
            // A limit on the address or on all sign-ins spends no compare: that is what keeps the CPU for everything else.
            if (attempt.reason === 'IN_FLIGHT' || attempt.reason === 'LOCKED') await bcrypt.compare(password, DUMMY_HASH);
            return null;
          }
          const user = await db().user.findUnique({ where: { email: email.toLowerCase() } });
          const ok = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
          // A disabled user is answered like a wrong password (#145).
          if (!user || !ok || user.disabledAt) return null;
          // An approver or admin without a second factor signs in to set one up, and can do nothing else.
          let mfa: MfaState = MFA_ROLES.includes(user.role) ? 'ENROLL' : 'NOT_REQUIRED';
          if (MFA_ROLES.includes(user.role) && user.totpEnabledAt) {
            if (!parsed.data.otp) {
              attempt.end('RELEASED');
              throw new Error(MFA_CODE_REQUIRED);
            }
            if (!(await verifySecondFactor(user, parsed.data.otp))) return null;
            mfa = 'VERIFIED';
          }
          attempt.end('SUCCEEDED');
          return { id: user.id, email: user.email, name: user.name, role: user.role, orgId: user.orgId, mfa, sessionVersion: user.sessionVersion };
        } finally {
          // A wrong password or code, or an error on the way, keeps the failure.
          attempt.end('FAILED');
        }
      },
    }),
  ],
  callbacks: {
    jwt({ token, user }) {
      if (user) {
        token.uid = user.id;
        token.role = user.role;
        token.orgId = user.orgId;
        token.mfa = user.mfa;
        token.sv = user.sessionVersion;
        token.signedInAt = Date.now();
      }
      return token;
    },
    session({ session, token }) {
      // A token from before the second factor existed carries no MFA state: it is not a session.
      if (token.uid && token.role && token.orgId && token.mfa) {
        session.user = { id: token.uid, email: token.email ?? '', name: token.name ?? '', role: token.role, orgId: token.orgId, mfa: token.mfa };
        session.sv = token.sv;
        session.signedInAt = token.signedInAt;
      }
      return session;
    },
  },
};

export type SessionUser = { id: string; email: string; name: string; role: Role; orgId: string; mfa: MfaState };

/** The signed-in user, or null. */
export async function currentUser(): Promise<SessionUser | null> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return null;
  return liveUser({ user: session.user, sv: session.sv, signedInAt: session.signedInAt });
}

/**
 * A session's user, if the session still stands (#145): it signed in less
 * than SESSION_MAX_AGE_MS ago, and the user row, read now, is not disabled,
 * carries the session's version, role and firm. A session from before
 * sessions carried a version stands for nothing.
 */
export async function liveUser(session: { user: SessionUser; sv?: number; signedInAt?: number }, now = new Date()): Promise<SessionUser | null> {
  if (session.sv === undefined || session.signedInAt === undefined) return null;
  if (now.getTime() - session.signedInAt > SESSION_MAX_AGE_MS || session.signedInAt > now.getTime() + 60_000) return null;
  const row = await db().user.findUnique({ where: { id: session.user.id }, select: { sessionVersion: true, disabledAt: true, role: true, orgId: true } });
  if (!row || row.disabledAt || row.sessionVersion !== session.sv || row.role !== session.user.role || row.orgId !== session.user.orgId) return null;
  return session.user;
}
