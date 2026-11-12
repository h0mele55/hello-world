import { NextResponse } from 'next/server';
import { z } from 'zod';
import { errorResponse, handler } from '@/lib/http';
import { setUserDisabled } from '@/lib/team';

const Body = z.strictObject({ disabled: z.boolean() });

/** An admin disables or enables another person (#145). */
export const PUT = handler<{ params: Promise<{ userId: string }> }>(async (req, user, ctx) => {
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return errorResponse('INVALID_INPUT');
  const { userId } = await ctx.params;
  return NextResponse.json(await setUserDisabled(user, userId, body.data.disabled), { headers: { 'Cache-Control': 'no-store' } });
}, { may: 'manageUsers' });
