import { NextResponse } from 'next/server';
import { handler } from '@/lib/http';
import { discardDraft } from '@/lib/reports/intake';

export const DELETE = handler<{ params: Promise<{ versionId: string }> }>(async (_req, user, ctx) => {
  await discardDraft(user, (await ctx.params).versionId);
  return new NextResponse(null, { status: 204 });
});
