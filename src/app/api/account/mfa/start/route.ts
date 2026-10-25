import { NextResponse } from 'next/server';
import { handler } from '@/lib/http';
import { startMfaSetup } from '@/lib/mfa';

/** A new TOTP secret for the caller's own account, to scan; it is held sealed until a code confirms it. */
export const POST = handler(
  async (_req, user) => NextResponse.json(await startMfaSetup(user), { headers: { 'Cache-Control': 'no-store' } }),
  { may: 'setUpMfa', duringMfaEnrollment: true },
);
