import { NextResponse } from 'next/server';
import { z } from 'zod';
import { errorResponse, handler, readBody } from '@/lib/http';
import { PDF_LIMITS } from '@/lib/pdf/parse';
import { uploadVersion } from '@/lib/reports/intake';

const Reason = z.enum(['INITIAL', 'CORRECTION', 'SUBSEQUENT_EVENT', 'OTHER']);

/** The PDF is the raw request body (Content-Type: application/pdf); the reason code is a query parameter. */
export const POST = handler<{ params: Promise<{ engagementId: string }> }>(async (req, user, ctx) => {
  const { engagementId } = await ctx.params;
  const reasonCode = Reason.safeParse(req.nextUrl.searchParams.get('reason'));
  if (!reasonCode.success) return errorResponse('INVALID_INPUT', 'reason');
  if (req.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/pdf') return errorResponse('UNSUPPORTED_MEDIA_TYPE');
  const bytes = await readBody(req, PDF_LIMITS.maxBytes);
  if (!bytes) return errorResponse('TOO_LARGE');
  const uploaded = await uploadVersion(user, { engagementId, reasonCode: reasonCode.data, bytes });
  return NextResponse.json({ id: uploaded.id, version: uploaded.version, anchorOnly: uploaded.anchorOnly, flags: uploaded.flags, found: uploaded.extraction.status === 'FOUND' }, { status: 201 });
});
