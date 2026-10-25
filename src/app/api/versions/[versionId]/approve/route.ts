import { NextResponse } from 'next/server';
import { z } from 'zod';
import { approveVersion } from '@/lib/anchoring/approve';
import { resolveAnchorTarget } from '@/lib/anchoring/queries';
import { errorResponse, handler } from '@/lib/http';

const Body = z.strictObject({
  /** The approver ticked "I have checked the confirmed opinion against the report". */
  approved: z.literal(true),
});

export const POST = handler<{ params: Promise<{ versionId: string }> }>(async (req, user, ctx) => {
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return errorResponse('INVALID_INPUT');
  // approveVersion checks the role first, then refuses a missing target by name.
  const result = await approveVersion(user, (await ctx.params).versionId, resolveAnchorTarget().target);
  return NextResponse.json(result);
}, { may: 'approve' });
