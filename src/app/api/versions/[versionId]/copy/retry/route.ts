import { NextResponse } from 'next/server';
import { requeueCopy } from '@/lib/anchoring/approve';
import { resolveAnchorTarget } from '@/lib/anchoring/queries';
import { handler } from '@/lib/http';

/** An approver queues the distribution copy again after its write failed. */
export const POST = handler<{ params: Promise<{ versionId: string }> }>(async (_req, user, ctx) => {
  return NextResponse.json(await requeueCopy(user, (await ctx.params).versionId, resolveAnchorTarget().target));
}, { may: 'approve' });
