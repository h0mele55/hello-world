import fs from 'node:fs/promises';
import path from 'node:path';
import type { PrismaClient } from '@/generated/prisma/client';

/**
 * Removes stored files no StoredFile row names, once they are older than a
 * grace period (#158). A discarded draft's file is not deleted with its row:
 * a backup takes the database first and the store after, and a file deleted
 * in between would be named in the dump and missing from the archive. Left to
 * this sweep, it outlives every backup taken while its row still existed.
 * The grace period also spares a file just stored whose row is not committed
 * yet.
 */

/** Longer than the time between two backups, with room for one that runs late. */
export const ORPHAN_GRACE_MS = 48 * 3_600_000;
const BATCH = 500;

export async function sweepOrphanFiles(options: { prisma: PrismaClient; dir: string; olderThanMs?: number; now?: () => Date }): Promise<{ removed: number; kept: number }> {
  const { prisma, dir } = options;
  const cutoff = (options.now?.() ?? new Date()).getTime() - (options.olderThanMs ?? ORPHAN_GRACE_MS);
  let names: string[];
  try {
    names = (await fs.readdir(dir)).filter((name) => name.endsWith('.bin'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { removed: 0, kept: 0 };
    throw error;
  }
  let removed = 0;
  let kept = 0;
  for (let i = 0; i < names.length; i += BATCH) {
    const batch = names.slice(i, i + BATCH);
    const named = new Set((await prisma.storedFile.findMany({ where: { path: { in: batch } }, select: { path: true } })).map((f) => f.path));
    for (const name of batch) {
      if (named.has(name)) continue;
      const file = path.join(dir, name);
      const stat = await fs.stat(file).catch(() => null);
      if (!stat) continue;
      if (stat.mtimeMs > cutoff) {
        kept += 1;
        continue;
      }
      // Read again just before removing it: a row naming it may have been committed meanwhile.
      if (await prisma.storedFile.findFirst({ where: { path: name }, select: { id: true } })) continue;
      await fs.rm(file, { force: true });
      removed += 1;
    }
  }
  return { removed, kept };
}
