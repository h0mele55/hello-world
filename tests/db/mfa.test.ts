import { PrismaPg } from '@prisma/adapter-pg';
import { generate } from 'otplib';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { SessionUser } from '@/auth';
import { PrismaClient } from '@/generated/prisma/client';
import { verifyAuditChain } from '@/lib/audit';
import { confirmMfaSetup, MfaError, RECOVERY_CODE_COUNT, startMfaSetup, verifySecondFactor } from '@/lib/mfa';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });

let orgId: string;
const make = async (email: string, role: SessionUser['role']): Promise<SessionUser> => {
  const user = await prisma.user.create({ data: { orgId, email, name: email, role, passwordHash: 'x' } });
  return { id: user.id, email, name: email, role, orgId, mfa: 'ENROLL' };
};
const rowOf = (id: string) => prisma.user.findUniqueOrThrow({ where: { id }, select: { id: true, orgId: true, totpSecret: true, totpLastStep: true, totpEnabledAt: true, totpPendingSecret: true } });
const codeAt = (secret: string, seconds: number) => generate({ secret, epoch: seconds });
const now = () => Math.floor(Date.now() / 1000);

async function mfaCode(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  return error instanceof MfaError ? error.code : String(error);
}

beforeEach(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE "RecoveryCode", "ChainWrite", "AuditEvent", "ReportVersion", "StoredFile", "Engagement", "Client", "User", "IssuerOrg" CASCADE');
  orgId = (await prisma.issuerOrg.create({ data: { name: 'Example Audit OOD' } })).id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('setting up two-step sign-in', () => {
  it('is for approvers and admins only', async () => {
    for (const role of ['VIEWER', 'PREPARER'] as const) {
      await expect(startMfaSetup(await make(`${role}@example.test`, role))).rejects.toMatchObject({ name: 'AccessError', code: 'FORBIDDEN' });
    }
  });

  it('holds the secret sealed until a code confirms it, then turns it on with recovery codes stored as hashes only', async () => {
    const approver = await make('approver@example.test', 'APPROVER');
    const { secret, uri, qr } = await startMfaSetup(approver);
    expect(uri).toMatch(/^otpauth:\/\/totp\//);
    expect(qr.path.length).toBeGreaterThan(100);
    const pending = await rowOf(approver.id);
    expect(pending.totpEnabledAt).toBeNull();
    expect(Buffer.from(pending.totpPendingSecret!).includes(Buffer.from(secret))).toBe(false);

    expect(await mfaCode(confirmMfaSetup(approver, '000000'))).toBe('CODE_INVALID');
    const { recoveryCodes } = await confirmMfaSetup(approver, await codeAt(secret, now()));
    expect(recoveryCodes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(new Set(recoveryCodes).size).toBe(RECOVERY_CODE_COUNT);
    for (const code of recoveryCodes) expect(code).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{4}){3}$/);

    const enabled = await rowOf(approver.id);
    expect(enabled.totpEnabledAt).not.toBeNull();
    expect(enabled.totpPendingSecret).toBeNull();
    expect(Buffer.from(enabled.totpSecret!).includes(Buffer.from(secret))).toBe(false);
    const stored = await prisma.recoveryCode.findMany({ where: { userId: approver.id } });
    expect(stored).toHaveLength(RECOVERY_CODE_COUNT);
    for (const { codeHash } of stored) {
      expect(codeHash).toMatch(/^[0-9a-f]{64}$/);
      expect(recoveryCodes.some((c) => codeHash.includes(c.replaceAll('-', '')))).toBe(false);
    }
    expect(await prisma.auditEvent.count({ where: { action: 'mfa.enabled', subjectId: approver.id } })).toBe(1);
    expect(await mfaCode(startMfaSetup(approver))).toBe('ALREADY_ENABLED');
    expect(await mfaCode(confirmMfaSetup(approver, await codeAt(secret, now())))).toBe('ALREADY_ENABLED');
  });

  it('refuses a confirmation with no setup in progress', async () => {
    expect(await mfaCode(confirmMfaSetup(await make('admin@example.test', 'ADMIN'), '123456'))).toBe('NO_SETUP_IN_PROGRESS');
  });
});

describe('the second factor at sign-in', () => {
  async function enrolled() {
    const admin = await make('admin@example.test', 'ADMIN');
    const { secret } = await startMfaSetup(admin);
    // Confirm with the previous period's code, so the current one is still unused.
    const { recoveryCodes } = await confirmMfaSetup(admin, await codeAt(secret, now() - 30));
    return { admin, secret, recoveryCodes };
  }

  it('accepts a code once, never the same time step again, and a later one after it', async () => {
    const { admin, secret } = await enrolled();
    const code = await codeAt(secret, now());
    expect(await verifySecondFactor(await rowOf(admin.id), code)).toBe(true);
    expect(await verifySecondFactor(await rowOf(admin.id), code)).toBe(false);
    expect(await verifySecondFactor(await rowOf(admin.id), await codeAt(secret, now() + 30))).toBe(true);
    expect(await verifySecondFactor(await rowOf(admin.id), await codeAt(secret, now() - 30))).toBe(false);
  });

  it('accepts each recovery code once, in any case and grouping, and records its use', async () => {
    const { admin, recoveryCodes } = await enrolled();
    const [first, second] = recoveryCodes;
    expect(await verifySecondFactor(await rowOf(admin.id), first.toLowerCase().replaceAll('-', ' '))).toBe(true);
    expect(await verifySecondFactor(await rowOf(admin.id), first)).toBe(false);
    expect(await verifySecondFactor(await rowOf(admin.id), second)).toBe(true);
    expect(await prisma.recoveryCode.count({ where: { userId: admin.id, usedAt: { not: null } } })).toBe(2);
    expect(await prisma.auditEvent.count({ where: { action: 'mfa.recovery_code_used' } })).toBe(2);
    expect(await verifyAuditChain(prisma, orgId)).toMatchObject({ ok: true });
  });

  it('refuses a wrong code, a malformed one, another account\'s recovery code, and an account without a second factor', async () => {
    const { admin, recoveryCodes } = await enrolled();
    const other = await make('approver@example.test', 'APPROVER');
    const { secret: otherSecret } = await startMfaSetup(other);
    const { recoveryCodes: otherCodes } = await confirmMfaSetup(other, await codeAt(otherSecret, now() - 30));
    expect(await verifySecondFactor(await rowOf(admin.id), '000000')).toBe(false);
    expect(await verifySecondFactor(await rowOf(admin.id), 'not a code')).toBe(false);
    expect(await verifySecondFactor(await rowOf(admin.id), otherCodes[0])).toBe(false);
    expect(await verifySecondFactor(await rowOf(other.id), recoveryCodes[0])).toBe(false);
    const plain = await make('preparer@example.test', 'PREPARER');
    expect(await verifySecondFactor(await rowOf(plain.id), '123456')).toBe(false);
  });

  it('lets only one of two sign-ins racing with the same code through', async () => {
    const { admin, secret } = await enrolled();
    const code = await codeAt(secret, now());
    const row = await rowOf(admin.id);
    const results = await Promise.all([verifySecondFactor(row, code), verifySecondFactor(row, code)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});
