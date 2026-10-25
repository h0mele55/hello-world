/**
 * Checks a restored copy (scripts/restore.sh) against the database it was
 * backed up from (Phase 5, #59). Fails, by name, unless:
 *
 *   - the copy has the same migrations applied;
 *   - every firm's audit chain re-derives in the copy, and its head is the
 *     same event, with the same hash, in the source;
 *   - every stored file the copy names is in the restored directory, opens
 *     under FILE_ENCRYPTION_KEY and matches its recorded SHA-256;
 *   - with --expect-identical, every table holds as many rows as the source
 *     (true only when nothing was written since the backup, as in CI).
 *
 *   DATABASE_URL=<source> RESTORE_DATABASE_URL=… RESTORE_FILE_STORAGE_DIR=… \
 *   FILE_ENCRYPTION_KEY=… npx tsx scripts/verify-restore.ts [--expect-identical]
 */
import path from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { PrismaClient } from '../src/generated/prisma/client';
import { verifyAuditChain } from '../src/lib/audit';
import { createFileStore } from '../src/lib/file-store';

const env = (name: string) => {
  const value = process.env[name];
  if (!value) {
    console.error(JSON.stringify({ level: 'error', message: `verify-restore refused: ${name} is not set` }));
    process.exit(2);
  }
  return value;
};

async function main() {
  const expectIdentical = process.argv.includes('--expect-identical');
  const sourceUrl = env('DATABASE_URL');
  const restoredUrl = env('RESTORE_DATABASE_URL');
  const dir = path.resolve(env('RESTORE_FILE_STORAGE_DIR'));
  const keyBytes = Buffer.from(env('FILE_ENCRYPTION_KEY'), 'base64');
  const key = { key: new Uint8Array(keyBytes), version: Number(process.env.FILE_ENCRYPTION_KEY_VERSION || 1) };
  const files = createFileStore({ dir, current: key, keys: [key] });

  const source = new pg.Client({ connectionString: sourceUrl });
  const restored = new pg.Client({ connectionString: restoredUrl });
  const restoredPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: restoredUrl }) });
  await Promise.all([source.connect(), restored.connect()]);
  const failures: { check: string; detail: string }[] = [];
  try {
    const migrations = async (client: pg.Client) =>
      (await client.query<{ name: string }>('SELECT migration_name AS name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY 1')).rows.map((r) => r.name).join(',');
    if ((await migrations(source)) !== (await migrations(restored))) failures.push({ check: 'MIGRATIONS_DIFFER', detail: '' });

    const orgs = (await restored.query<{ id: string }>('SELECT id FROM "IssuerOrg" ORDER BY id')).rows;
    for (const { id } of orgs) {
      const chain = await verifyAuditChain(restoredPrisma, id);
      if (!chain.ok) {
        failures.push({ check: 'AUDIT_CHAIN_BROKEN', detail: `${id} at ${chain.seq}: ${chain.reason}` });
        continue;
      }
      if (chain.count === 0) continue;
      const { rows } = await source.query<{ hash: string }>('SELECT hash FROM "AuditEvent" WHERE "orgId" = $1 AND seq = $2', [id, chain.count]);
      if (rows[0]?.hash !== chain.head) failures.push({ check: 'AUDIT_HEAD_DIFFERS', detail: `${id} at ${chain.count}` });
    }

    const stored = (
      await restored.query<{ id: string; path: string; iv: Buffer; authTag: Buffer; keyVersion: number; sha256: string; size: number }>(
        'SELECT id, path, iv, "authTag", "keyVersion", sha256, size FROM "StoredFile" ORDER BY id',
      )
    ).rows;
    for (const file of stored) {
      try {
        await files.read({ path: file.path, iv: new Uint8Array(file.iv), authTag: new Uint8Array(file.authTag), keyVersion: file.keyVersion, sha256: file.sha256, size: file.size });
      } catch (error) {
        failures.push({ check: 'FILE_UNREADABLE', detail: `${file.id}: ${error instanceof Error ? (('code' in error && String(error.code)) || error.name) : typeof error}` });
      }
    }

    const tables = (await restored.query<{ name: string }>("SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' ORDER BY 1")).rows.map((r) => r.name);
    const counts: Record<string, { source: number; restored: number }> = {};
    for (const table of tables) {
      const count = async (client: pg.Client) => Number((await client.query<{ n: string }>(`SELECT count(*) AS n FROM "${table.replaceAll('"', '""')}"`)).rows[0].n);
      counts[table] = { source: await count(source), restored: await count(restored) };
      if (expectIdentical && counts[table].source !== counts[table].restored) failures.push({ check: 'ROW_COUNT_DIFFERS', detail: table });
    }

    console.log(JSON.stringify({ level: failures.length ? 'error' : 'info', message: failures.length ? 'restore check failed' : 'restore verified', orgs: orgs.length, files: stored.length, counts, failures }));
    if (failures.length) process.exitCode = 1;
  } finally {
    await Promise.all([source.end(), restored.end(), restoredPrisma.$disconnect()]);
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ level: 'error', message: 'verify-restore stopped', error: error instanceof Error ? error.name : typeof error }));
  process.exit(2);
});
