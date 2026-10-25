/**
 * Seeds the one issuer organisation (#5) and two users: a preparer and an
 * approver. Passwords come from the environment, never from this file:
 *
 *   SEED_ORG_NAME              the audit firm's name
 *   SEED_PREPARER_EMAIL        SEED_PREPARER_PASSWORD
 *   SEED_APPROVER_EMAIL        SEED_APPROVER_PASSWORD
 *   SEED_ADMIN_EMAIL           SEED_ADMIN_PASSWORD      optional
 *   SEED_VIEWER_EMAIL          SEED_VIEWER_PASSWORD     optional
 *
 * For development and CI only, SEED_APPROVER_TOTP_SECRET (base32) turns the
 * approver's two-step sign-in on with that secret, so tests can compute its
 * codes; it needs FILE_ENCRYPTION_KEY to seal the secret as the app does.
 * Without it, the approver sets two-step sign-in up at first sign-in.
 *
 * Re-running updates names, roles and passwords in place.
 */
import { PrismaPg } from '@prisma/adapter-pg';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '../src/generated/prisma/client';
import { totpSecretContext } from '../src/lib/mfa-context';
import { seal } from '../src/lib/sealed';

/** The app's sealing key, read the way src/lib/server-env.ts reads it. */
function sealingKey() {
  const key = Buffer.from(env('FILE_ENCRYPTION_KEY'), 'base64');
  if (key.length !== 32) throw new Error('FILE_ENCRYPTION_KEY must be 32 bytes, base64');
  return { key: new Uint8Array(key), version: Number(process.env.FILE_ENCRYPTION_KEY_VERSION ?? 1) };
}

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function password(name: string): string {
  const value = env(name);
  if (value.length < 12) throw new Error(`${name} must be at least 12 characters`);
  return value;
}

async function main() {
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: env('DATABASE_URL') }) });
  try {
    const orgName = env('SEED_ORG_NAME');
    const org = (await prisma.issuerOrg.findFirst({ where: { name: orgName } })) ?? (await prisma.issuerOrg.create({ data: { name: orgName } }));
    const users: { email: string; name: string; role: 'PREPARER' | 'APPROVER' | 'ADMIN' | 'VIEWER'; password: string }[] = [
      { email: env('SEED_PREPARER_EMAIL'), name: 'Preparer', role: 'PREPARER', password: password('SEED_PREPARER_PASSWORD') },
      { email: env('SEED_APPROVER_EMAIL'), name: 'Approver', role: 'APPROVER', password: password('SEED_APPROVER_PASSWORD') },
    ];
    for (const [role, name] of [['ADMIN', 'Admin'], ['VIEWER', 'Viewer']] as const) {
      if (process.env[`SEED_${role}_EMAIL`]) users.push({ email: env(`SEED_${role}_EMAIL`), name, role, password: password(`SEED_${role}_PASSWORD`) });
    }
    const emails = users.map((user) => user.email.toLowerCase());
    if (new Set(emails).size !== emails.length) throw new Error('every seeded user must be a different person');
    for (const user of users) {
      const passwordHash = await bcrypt.hash(user.password, 12);
      const email = user.email.toLowerCase();
      const seeded = await prisma.user.upsert({
        where: { email },
        create: { email, name: user.name, role: user.role, passwordHash, orgId: org.id },
        update: { name: user.name, role: user.role, passwordHash, orgId: org.id },
      });
      console.log(`seeded ${user.role.toLowerCase()} ${email}`);
      const totp = user.role === 'APPROVER' ? process.env.SEED_APPROVER_TOTP_SECRET : undefined;
      if (totp) {
        if (!/^[A-Z2-7]{16,}$/.test(totp)) throw new Error('SEED_APPROVER_TOTP_SECRET must be base32, at least 16 characters');
        await prisma.user.update({
          where: { id: seeded.id },
          data: { totpSecret: seal(sealingKey(), new TextEncoder().encode(totp), totpSecretContext(seeded.id)), totpEnabledAt: new Date(), totpLastStep: null, totpPendingSecret: null },
        });
        console.log(`turned on two-step sign-in for ${email}`);
      }
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
