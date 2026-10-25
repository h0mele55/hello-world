import { NextResponse } from 'next/server';
import { reviewUnjournaledWrite } from '@/lib/console/registry-watch';
import { handler } from '@/lib/http';

export const POST = handler<{ params: Promise<{ findingId: string }> }>(async (_req, user, ctx) => {
  return NextResponse.json(await reviewUnjournaledWrite(user, (await ctx.params).findingId));
}, { may: 'reviewUnjournaledWrite' });
