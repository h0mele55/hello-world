import { NextResponse } from 'next/server';
import { z } from 'zod';
import { setChainWriteMode } from '@/lib/anchoring/approve';
import { MODE_LADDER } from '@/lib/anchoring/ladder';
import { errorResponse, handler } from '@/lib/http';

const Body = z.strictObject({ mode: z.enum(MODE_LADDER) });

export const PUT = handler(async (req, user) => {
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return errorResponse('INVALID_INPUT');
  return NextResponse.json(await setChainWriteMode(user, body.data.mode));
});
