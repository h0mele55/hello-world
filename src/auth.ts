import 'server-only';
import bcrypt from 'bcryptjs';
import type { NextAuthOptions } from 'next-auth';
import { getServerSession } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import { z } from 'zod';
import type { Role } from '@/generated/prisma/enums';
import { db } from '@/lib/db';
import { isThrottled, recordFailure, recordSuccess } from '@/lib/login-throttle';
import { serverEnv } from '@/lib/server-env';

declare module 'next-auth' {
  interface Session {
    user: { id: string; email: string; name: string; role: Role; orgId: string };
  }
  interface User {
    role: Role;
    orgId: string;
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    uid?: string;
    role?: Role;
    orgId?: string;
  }
}

const Login = z.object({ email: z.email().max(254), password: z.string().min(1).max(200) });

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
      credentials: { email: { type: 'email' }, password: { type: 'password' } },
      async authorize(credentials, req) {
        serverEnv();
        const parsed = Login.safeParse(credentials);
        if (!parsed.success) return null;
        const { email, password } = parsed.data;
        const address = clientAddress(req?.headers);
        if (isThrottled(email, address)) {
          await bcrypt.compare(password, DUMMY_HASH);
          return null;
        }
        const user = await db().user.findUnique({ where: { email: email.toLowerCase() } });
        const ok = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
        if (!user || !ok) {
          recordFailure(email, address);
          return null;
        }
        recordSuccess(email);
        return { id: user.id, email: user.email, name: user.name, role: user.role, orgId: user.orgId };
      },
    }),
  ],
  callbacks: {
    jwt({ token, user }) {
      if (user) {
        token.uid = user.id;
        token.role = user.role;
        token.orgId = user.orgId;
      }
      return token;
    },
    session({ session, token }) {
      if (token.uid && token.role && token.orgId) {
        session.user = { id: token.uid, email: token.email ?? '', name: token.name ?? '', role: token.role, orgId: token.orgId };
      }
      return session;
    },
  },
};

export type SessionUser = { id: string; email: string; name: string; role: Role; orgId: string };

/** The signed-in user, or null. */
export async function currentUser(): Promise<SessionUser | null> {
  const session = await getServerSession(authOptions);
  return session?.user?.id ? session.user : null;
}
