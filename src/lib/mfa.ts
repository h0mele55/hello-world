import 'server-only';
import { createHash, randomBytes } from 'node:crypto';
import { generateSecret, generateURI, verify } from 'otplib';
import QRCode from 'qrcode';
import type { SessionUser } from '@/auth';
import { appendAuditEvent } from '@/lib/audit';
import { db } from '@/lib/db';
import { currentSealingKey, sealingKeys } from '@/lib/keys';
import { totpPendingContext, totpSecretContext } from '@/lib/mfa-context';
import { requireRole } from '@/lib/roles';
import { open, seal } from '@/lib/sealed';

/**
 * TOTP second factor for approvers and admins (Phase 5, #52). The secret is
 * sealed at rest; a code is accepted once (its time step must be later than
 * the last one accepted); recovery codes are stored as SHA-256 only and shown
 * once. Nothing here logs a secret or a code.
 */

export const ISSUER_LABEL = 'Audit Report Anchoring';
export const RECOVERY_CODE_COUNT = 10;
/** One period either side, for a phone clock that is a little off. */
const EPOCH_TOLERANCE_SECONDS = 30;

/** The time step a TOTP verification matched, or null when it did not. */
async function matchedStep(options: { secret: string; token: string; afterTimeStep?: number }): Promise<number | null> {
  const result = await verify({ ...options, epochTolerance: EPOCH_TOLERANCE_SECONDS }).catch(() => null);
  return result?.valid && 'timeStep' in result ? result.timeStep : null;
}


export class MfaError extends Error {
  constructor(readonly code: 'NOT_FOUND' | 'ALREADY_ENABLED' | 'NO_SETUP_IN_PROGRESS' | 'CODE_INVALID') {
    super(code);
    this.name = 'MfaError';
  }
}

/** The dark modules of the otpauth URI's QR code, as one SVG path in module units (quiet zone included). */
function qrPath(text: string): { size: number; path: string } {
  const { modules } = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const quiet = 4;
  let path = '';
  for (let row = 0; row < modules.size; row++) {
    for (let col = 0; col < modules.size; col++) if (modules.get(row, col)) path += `M${col + quiet} ${row + quiet}h1v1h-1z`;
  }
  return { size: modules.size + 2 * quiet, path };
}

/** Starts (or restarts) setting up the second factor: a new secret, held sealed until a code confirms it. */
export async function startMfaSetup(user: SessionUser) {
  requireRole(user, 'setUpMfa');
  const row = await db().user.findUnique({ where: { id: user.id }, select: { email: true, totpEnabledAt: true } });
  if (!row) throw new MfaError('NOT_FOUND');
  if (row.totpEnabledAt) throw new MfaError('ALREADY_ENABLED');
  const secret = generateSecret();
  await db().user.update({ where: { id: user.id }, data: { totpPendingSecret: seal(currentSealingKey(), new TextEncoder().encode(secret), totpPendingContext(user.id)) } });
  const uri = generateURI({ issuer: ISSUER_LABEL, label: row.email, secret });
  return { secret, uri, qr: qrPath(uri) };
}

const normaliseRecovery = (code: string) => code.toUpperCase().replace(/[\s-]/g, '');
const recoveryHash = (userId: string, code: string) => createHash('sha256').update(`recovery-code:v1:${userId}:${normaliseRecovery(code)}`).digest('hex');

/** 16 base32 characters (80 bits) in four groups: XXXX-XXXX-XXXX-XXXX. */
function newRecoveryCode(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bytes = randomBytes(16);
  const chars = [...bytes].map((b) => alphabet[b & 31]).join('');
  return chars.match(/.{4}/g)!.join('-');
}

/** Confirms the setup with a code from the authenticator, turns the second factor on and returns the recovery codes, once. */
export async function confirmMfaSetup(user: SessionUser, code: string): Promise<{ recoveryCodes: string[] }> {
  requireRole(user, 'setUpMfa');
  const row = await db().user.findUnique({ where: { id: user.id }, select: { totpEnabledAt: true, totpPendingSecret: true } });
  if (!row) throw new MfaError('NOT_FOUND');
  if (row.totpEnabledAt) throw new MfaError('ALREADY_ENABLED');
  if (!row.totpPendingSecret) throw new MfaError('NO_SETUP_IN_PROGRESS');
  const secret = new TextDecoder().decode(open(sealingKeys(), row.totpPendingSecret, totpPendingContext(user.id)));
  const step = await matchedStep({ secret, token: code.trim() });
  if (step === null) throw new MfaError('CODE_INVALID');
  const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
  await db().$transaction(async (tx) => {
    const updated = await tx.user.updateMany({
      where: { id: user.id, totpEnabledAt: null },
      data: {
        totpSecret: seal(currentSealingKey(), new TextEncoder().encode(secret), totpSecretContext(user.id)),
        totpEnabledAt: new Date(),
        totpLastStep: step,
        totpPendingSecret: null,
      },
    });
    if (updated.count !== 1) throw new MfaError('ALREADY_ENABLED');
    await tx.recoveryCode.deleteMany({ where: { userId: user.id } });
    await tx.recoveryCode.createMany({ data: recoveryCodes.map((c) => ({ userId: user.id, codeHash: recoveryHash(user.id, c) })) });
    await appendAuditEvent(tx, { orgId: user.orgId, actorId: user.id, action: 'mfa.enabled', subjectType: 'User', subjectId: user.id, data: { recoveryCodes: RECOVERY_CODE_COUNT } });
  });
  return { recoveryCodes };
}

/**
 * Checks the second factor at sign-in: a TOTP code later than the last one
 * accepted, or an unused recovery code, which is then spent. The step and
 * the spending are conditional writes, so two sign-ins racing with one code
 * cannot both pass.
 */
export async function verifySecondFactor(user: { id: string; orgId: string; totpSecret: Uint8Array | null; totpLastStep: number | null }, input: string): Promise<boolean> {
  if (!user.totpSecret) return false;
  const token = input.trim();
  if (/^\d{6}$/.test(token)) {
    const secret = new TextDecoder().decode(open(sealingKeys(), user.totpSecret, totpSecretContext(user.id)));
    const step = await matchedStep({ secret, token, afterTimeStep: user.totpLastStep ?? undefined });
    if (step === null) return false;
    const claimed = await db().$executeRaw`UPDATE "User" SET "totpLastStep" = ${step} WHERE id = ${user.id} AND ("totpLastStep" IS NULL OR "totpLastStep" < ${step})`;
    return claimed === 1;
  }
  if (normaliseRecovery(token).length !== 16) return false;
  return db().$transaction(async (tx) => {
    const spent = await tx.recoveryCode.updateMany({ where: { userId: user.id, codeHash: recoveryHash(user.id, token), usedAt: null }, data: { usedAt: new Date() } });
    if (spent.count !== 1) return false;
    await appendAuditEvent(tx, { orgId: user.orgId, actorId: user.id, action: 'mfa.recovery_code_used', subjectType: 'User', subjectId: user.id, data: {} });
    return true;
  });
}
