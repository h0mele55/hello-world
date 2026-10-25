/**
 * Seeds the one issuer organisation (#5) and two users: a preparer and an
 * approver. Passwords come from the environment, never from this file:
 *
 *   SEED_ORG_NAME              the audit firm's name
 *   SEED_PREPARER_EMAIL        SEED_PREPARER_PASSWORD
 *   SEED_APPROVER_EMAIL        SEED_APPROVER_PASSWORD
 *
 * Re-running updates names, roles and passwords in place.
 */
import { PrismaPg } from '@prisma/adapter-pg';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '../src/generated/prisma/client';

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
    const users = [
      { email: env('SEED_PREPARER_EMAIL'), name: 'Preparer', role: 'PREPARER' as const, password: password('SEED_PREPARER_PASSWORD') },
      { email: env('SEED_APPROVER_EMAIL'), name: 'Approver', role: 'APPROVER' as const, password: password('SEED_APPROVER_PASSWORD') },
    ];
    if (users[0].email.toLowerCase() === users[1].email.toLowerCase()) throw new Error('the preparer and the approver must be different people');
    for (const user of users) {
      const passwordHash = await bcrypt.hash(user.password, 12);
      const email = user.email.toLowerCase();
      await prisma.user.upsert({
        where: { email },
        create: { email, name: user.name, role: user.role, passwordHash, orgId: org.id },
        update: { name: user.name, role: user.role, passwordHash, orgId: org.id },
      });
      console.log(`seeded ${user.role.toLowerCase()} ${email}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
