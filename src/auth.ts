import 'server-only';
import bcrypt from 'bcryptjs';
import type { NextAuthOptions } from 'next-auth';
import { getServerSession } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import { z } from 'zod';
import type { Role } from '@/generated/prisma/enums';
import { db } from '@/lib/db';
import { isThrottled, recordFailure, recordSuccess, takeSignInAttempt } from '@/lib/login-throttle';
import { verifySecondFactor } from '@/lib/mfa';
import { MFA_ROLES, type MfaState } from '@/lib/roles';
import { serverEnv } from '@/lib/server-env';

declare module 'next-auth' {
  interface Session {
    user: SessionUser;
  }
  interface User {
    role: Role;
    orgId: string;
    mfa: MfaState;
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    uid?: string;
    role?: Role;
    orgId?: string;
    mfa?: MfaState;
  }
}

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

/** The client address, only when a trusted proxy set it (see login-throttle.ts). */
function clientAddress(headers: Record<string, unknown> | undefined): string | null {
  if (process.env.TRUST_PROXY_HEADERS !== '1') return null;
  const forwarded = headers?.['x-forwarded-for'];
  const first = typeof forwarded === 'string' ? forwarded.split(',')[0]?.trim() : undefined;
  return first || null;
}

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
        const address = clientAddress(req?.headers);
        if (!takeSignInAttempt(address) || isThrottled(email, address)) {
          await bcrypt.compare(password, DUMMY_HASH);
          return null;
        }
        const user = await db().user.findUnique({ where: { email: email.toLowerCase() } });
        const ok = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
        if (!user || !ok) {
          recordFailure(email, address);
          return null;
        }
        // An approver or admin without a second factor signs in to set one up, and can do nothing else.
        let mfa: MfaState = MFA_ROLES.includes(user.role) ? 'ENROLL' : 'NOT_REQUIRED';
        if (MFA_ROLES.includes(user.role) && user.totpEnabledAt) {
          if (!parsed.data.otp) throw new Error(MFA_CODE_REQUIRED);
          if (!(await verifySecondFactor(user, parsed.data.otp))) {
            recordFailure(email, address);
            return null;
          }
          mfa = 'VERIFIED';
        }
        recordSuccess(email);
        return { id: user.id, email: user.email, name: user.name, role: user.role, orgId: user.orgId, mfa };
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
      }
      return token;
    },
    session({ session, token }) {
      // A token from before the second factor existed carries no MFA state: it is not a session.
      if (token.uid && token.role && token.orgId && token.mfa) {
        session.user = { id: token.uid, email: token.email ?? '', name: token.name ?? '', role: token.role, orgId: token.orgId, mfa: token.mfa };
      }
      return session;
    },
  },
};

export type SessionUser = { id: string; email: string; name: string; role: Role; orgId: string; mfa: MfaState };

/** The signed-in user, or null. */
export async function currentUser(): Promise<SessionUser | null> {
  const session = await getServerSession(authOptions);
  return session?.user?.id ? session.user : null;
}
