/**
 * Prisma 7 configuration: the CLI (migrate, generate) reads the schema,
 * migrations and connection URL from here. The runtime client in
 * src/lib/db.ts connects through @prisma/adapter-pg with DATABASE_URL.
 */
import path from 'node:path';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: path.join('prisma', 'schema.prisma'),
  migrations: {
    path: path.join('prisma', 'migrations'),
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: process.env.DATABASE_URL ?? '',
  },
});
