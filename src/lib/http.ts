import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import { currentUser, type SessionUser } from '@/auth';
import { AnchoringError, type AnchoringErrorCode } from '@/lib/anchoring/errors';
import { IntakeError, type IntakeErrorCode } from '@/lib/reports/intake';
import { MfaError } from '@/lib/mfa';
import { takeMutation } from '@/lib/rate-limit';
import { AccessError, MFA_ROLES, mayDo, type Act } from '@/lib/roles';

/**
 * Route-handler plumbing: a signed-in user, a same-origin check on every
 * write, the caller's role for the act the route performs, and named errors
 * mapped to HTTP statuses. A response body carries a code the UI translates,
 * never a stack, a file byte or an opinion.
 */

const STATUS: Record<
  IntakeErrorCode | AnchoringErrorCode | AccessError['code'] | MfaError['code'] | 'UNAUTHENTICATED' | 'CROSS_ORIGIN' | 'TOO_LARGE' | 'UNSUPPORTED_MEDIA_TYPE' | 'RATE_LIMITED' | 'INTERNAL',
  number
> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  MFA_REQUIRED: 403,
  RATE_LIMITED: 429,
  CROSS_ORIGIN: 403,
  NOT_FOUND: 404,
  INVALID_INPUT: 400,
  TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  PDF_REFUSED: 422,
  DOC_ALREADY_UPLOADED: 409,
  ENGAGEMENT_EXISTS: 409,
  DRAFT_PENDING: 409,
  VERSION_CONFLICT: 409,
  NOT_DRAFT: 409,
  NOT_CONFIRMED: 409,
  FOUR_EYES: 403,
  CHAIN_WRITES_DISABLED: 409,
  CHAIN_NOT_CONFIGURED: 503,
  PREDECESSOR_NOT_ANCHORED: 409,
  ALREADY_QUEUED: 409,
  MODE_UNCHANGED: 409,
  MODE_SKIPS_RUNG: 409,
  NOT_ANCHORED: 409,
  ANCHOR_ONLY: 409,
  NOT_COMPLETE: 409,
  ALREADY_ENABLED: 409,
  NO_SETUP_IN_PROGRESS: 409,
  CODE_INVALID: 422,
  INTERNAL: 500,
};

export type ErrorCode = keyof typeof STATUS;

export function errorResponse(code: ErrorCode, detail?: string) {
  return NextResponse.json({ error: code, ...(detail ? { detail } : {}) }, { status: STATUS[code], headers: { 'Cache-Control': 'no-store' } });
}

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** A write must come from this site: the Origin header, when sent, must match the Host. */
function isSameOrigin(req: NextRequest): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return req.headers.get('sec-fetch-site') !== 'cross-site';
  try {
    return new URL(origin).host === req.headers.get('host');
  } catch {
    return false;
  }
}

export interface HandlerOptions {
  /** The act this route performs; a caller whose role may not do it is refused before anything runs. */
  may?: Act;
  /** Open to a signed-in approver or admin who has yet to set up a second factor (the setup routes only). */
  duringMfaEnrollment?: boolean;
}

/**
 * Every route goes through here. A write must name the act it performs
 * (`may`); `tests/unit/route-roles.test.ts` holds every mutating route to that
 * and proves a VIEWER is refused.
 */
export function handler<Ctx>(fn: (req: NextRequest, user: SessionUser, ctx: Ctx) => Promise<Response>, options: HandlerOptions = {}) {
  return async (req: NextRequest, ctx: Ctx): Promise<Response> => {
    if (WRITE_METHODS.has(req.method) && !isSameOrigin(req)) return errorResponse('CROSS_ORIGIN');
    const user = await currentUser();
    if (!user) return errorResponse('UNAUTHENTICATED');
    if (user.mfa === 'ENROLL' && MFA_ROLES.includes(user.role) && !options.duringMfaEnrollment) return errorResponse('MFA_REQUIRED');
    if (options.may && !mayDo(user.role, options.may)) return errorResponse('FORBIDDEN');
    if (WRITE_METHODS.has(req.method)) {
      const taken = takeMutation(user.id);
      if (!taken.ok) {
        const response = errorResponse('RATE_LIMITED');
        response.headers.set('Retry-After', String(taken.retryAfterSeconds));
        return response;
      }
    }
    try {
      return await fn(req, user, ctx);
    } catch (error) {
      if (error instanceof IntakeError || error instanceof AnchoringError || error instanceof AccessError) return errorResponse(error.code, error.detail);
      if (error instanceof MfaError) return errorResponse(error.code);
      // The name only: a message could carry user data.
      console.error(`Unhandled ${error instanceof Error ? error.name : typeof error} in ${req.method} ${req.nextUrl.pathname}`);
      return errorResponse('INTERNAL');
    }
  };
}

/** Reads a request body, refusing it as soon as it passes `limit` bytes. */
export async function readBody(req: NextRequest, limit: number): Promise<Uint8Array | null> {
  const declared = Number(req.headers.get('content-length') ?? 0);
  if (declared > limit) return null;
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new Uint8Array(Buffer.concat(chunks));
}
