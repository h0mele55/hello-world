import { NextResponse } from 'next/server';
import { handler } from '@/lib/http';
import { resetSecondFactor } from '@/lib/team';

/** An admin resets another person's second factor (#145). */
export const POST = handler<{ params: Promise<{ userId: string }> }>(async (_req, user, ctx) => {
  const { userId } = await ctx.params;
  return NextResponse.json(await resetSecondFactor(user, userId), { headers: { 'Cache-Control': 'no-store' } });
}, { may: 'manageUsers' });
