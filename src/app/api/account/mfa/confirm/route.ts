import { NextResponse } from 'next/server';
import { z } from 'zod';
import { errorResponse, handler, readJson } from '@/lib/http';
import { confirmMfaSetup } from '@/lib/mfa';

const Body = z.strictObject({ code: z.string().trim().regex(/^\d{6}$/) });

/** Turns the second factor on with a code from the authenticator, and returns the recovery codes, once. */
export const POST = handler(
  async (req, user) => {
    const body = Body.safeParse(await readJson(req));
    if (!body.success) return errorResponse('INVALID_INPUT');
    return NextResponse.json(await confirmMfaSetup(user, body.data.code), { headers: { 'Cache-Control': 'no-store' } });
  },
  { may: 'setUpMfa', duringMfaEnrollment: true },
);
