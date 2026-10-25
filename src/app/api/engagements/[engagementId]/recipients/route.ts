import { NextResponse } from 'next/server';
import { z } from 'zod';
import { errorResponse, handler } from '@/lib/http';
import { EMAIL_LOCALES } from '@/lib/notifications/email';
import { addRecipient } from '@/lib/reports/recipients';

const Body = z.strictObject({
  name: z.string().trim().min(1).max(200),
  email: z.email().max(254),
  locale: z.enum(EMAIL_LOCALES),
});

export const POST = handler<{ params: Promise<{ engagementId: string }> }>(async (req, user, ctx) => {
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return errorResponse('INVALID_INPUT');
  const result = await addRecipient(user, { engagementId: (await ctx.params).engagementId, ...body.data });
  return NextResponse.json(result, { status: 201 });
}, { may: 'manageRecipients' });
