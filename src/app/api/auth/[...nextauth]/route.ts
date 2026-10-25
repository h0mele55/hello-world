import type { NextRequest } from 'next/server';
import NextAuth from 'next-auth';
import { authOptions } from '@/auth';

export const dynamic = 'force-dynamic';

// NextAuth v4 reads `params.nextauth` synchronously; Next 16 passes params as
// a Promise, so resolve it first (the same compatibility shim Inflect uses).
const handler = NextAuth(authOptions);
type RouteContext = { params: Promise<{ nextauth: string[] }> };

export async function GET(req: NextRequest, ctx: RouteContext) {
  return handler(req, { params: await ctx.params });
}

export async function POST(req: NextRequest, ctx: RouteContext) {
  return handler(req, { params: await ctx.params });
}
