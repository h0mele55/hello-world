import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requestRevocation } from '@/lib/anchoring/revocation';
import { errorResponse, handler } from '@/lib/http';
import { REVOCATION_REASONS } from '@/lib/revocation-reasons';

const Body = z.strictObject({
  reason: z.enum(REVOCATION_REASONS as [string, ...string[]]).transform((r) => r as (typeof REVOCATION_REASONS)[number]),
  note: z.string().trim().min(1).max(1000),
  /** The engagement's reference, typed by the admin. */
  confirmation: z.string().max(200),
});

export const POST = handler<{ params: Promise<{ versionId: string }> }>(async (req, user, ctx) => {
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return errorResponse('INVALID_INPUT');
  const result = await requestRevocation(user, { versionId: (await ctx.params).versionId, ...body.data });
  return NextResponse.json(result, { status: 201 });
}, { may: 'requestRevocation' });
