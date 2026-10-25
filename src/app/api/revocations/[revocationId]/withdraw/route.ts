import { NextResponse } from 'next/server';
import { withdrawRevocation } from '@/lib/anchoring/revocation';
import { handler } from '@/lib/http';

export const POST = handler<{ params: Promise<{ revocationId: string }> }>(async (_req, user, ctx) => {
  return NextResponse.json(await withdrawRevocation(user, (await ctx.params).revocationId));
}, { may: 'requestRevocation' });
