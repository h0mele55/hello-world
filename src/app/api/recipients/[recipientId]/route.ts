import { NextResponse } from 'next/server';
import { handler } from '@/lib/http';
import { removeRecipient } from '@/lib/reports/recipients';

export const DELETE = handler<{ params: Promise<{ recipientId: string }> }>(async (_req, user, ctx) => {
  await removeRecipient(user, (await ctx.params).recipientId);
  return NextResponse.json({ removed: true });
}, { may: 'manageRecipients' });
