import { NextResponse } from 'next/server';
import { z } from 'zod';
import { errorResponse, handler } from '@/lib/http';
import { confirmOpinion } from '@/lib/reports/intake';

const Body = z.strictObject({
  opinionType: z.enum(['UNMODIFIED', 'QUALIFIED', 'ADVERSE', 'DISCLAIMER']),
  text: z.string().max(20_000),
  reportDate: z.string().max(10),
  /** The person ticked "I have read the opinion against the report". */
  confirmed: z.literal(true),
});

export const POST = handler<{ params: Promise<{ versionId: string }> }>(async (req, user, ctx) => {
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return errorResponse('INVALID_INPUT');
  const { opinionType, text, reportDate } = body.data;
  const result = await confirmOpinion(user, { versionId: (await ctx.params).versionId, opinionType, text, reportDate });
  return NextResponse.json(result);
});
