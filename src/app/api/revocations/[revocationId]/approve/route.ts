import { NextResponse } from 'next/server';
import { z } from 'zod';
import { resolveAnchorTarget } from '@/lib/anchoring/queries';
import { approveRevocation } from '@/lib/anchoring/revocation';
import { errorResponse, handler, readJson } from '@/lib/http';

const Body = z.strictObject({
  /** The approver confirmed the revocation in the dialog. */
  approved: z.literal(true),
});

export const POST = handler<{ params: Promise<{ revocationId: string }> }>(async (req, user, ctx) => {
  const body = Body.safeParse(await readJson(req));
  if (!body.success) return errorResponse('INVALID_INPUT');
  const result = await approveRevocation(user, (await ctx.params).revocationId, resolveAnchorTarget().target);
  return NextResponse.json(result);
}, { may: 'approve' });
