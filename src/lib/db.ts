import 'server-only';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@/generated/prisma/client';
import { serverEnv } from './server-env';

/**
 * The one database client. Prisma 7 connects through a driver adapter; in
 * development the client is kept on globalThis so hot reloads do not open a
 * new pool each time.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export function db(): PrismaClient {
  if (!globalForPrisma.prisma) {
    // A finite connection timeout, so an exhausted pool fails a request
    // instead of hanging it.
    const adapter = new PrismaPg({ connectionString: serverEnv().DATABASE_URL, max: 10, connectionTimeoutMillis: 10_000 });
    globalForPrisma.prisma = new PrismaClient({ adapter });
  }
  return globalForPrisma.prisma;
}
