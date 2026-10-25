import { NextResponse } from 'next/server';
import { rejectRevocation } from '@/lib/anchoring/revocation';
import { handler } from '@/lib/http';

export const POST = handler<{ params: Promise<{ revocationId: string }> }>(async (_req, user, ctx) => {
  return NextResponse.json(await rejectRevocation(user, (await ctx.params).revocationId));
}, { may: 'approve' });
