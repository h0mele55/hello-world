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
  /** Which of the PDF's reports the person started from, when it holds several (#77). */
  candidate: z.number().int().min(0).max(99).optional(),
});

export const POST = handler<{ params: Promise<{ versionId: string }> }>(async (req, user, ctx) => {
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return errorResponse('INVALID_INPUT');
  const { opinionType, text, reportDate, candidate } = body.data;
  const result = await confirmOpinion(user, { versionId: (await ctx.params).versionId, opinionType, text, reportDate, candidate });
  return NextResponse.json(result);
}, { may: 'prepare' });
