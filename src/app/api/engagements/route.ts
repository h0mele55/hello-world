import { NextResponse } from 'next/server';
import { z } from 'zod';
import { errorResponse, handler } from '@/lib/http';
import { createEngagement } from '@/lib/reports/intake';

const Body = z.strictObject({
  clientName: z.string().max(200),
  registrationNumber: z.string().max(64),
  country: z.string().max(8),
  engagementRef: z.string().max(200),
  periodEnd: z.string().max(10),
  reportType: z.enum(['STANDALONE', 'CONSOLIDATED']),
});

export const POST = handler(async (req, user) => {
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return errorResponse('INVALID_INPUT');
  const engagement = await createEngagement(user, body.data);
  return NextResponse.json({ id: engagement.id }, { status: 201 });
});
