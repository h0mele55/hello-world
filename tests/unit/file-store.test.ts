import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFileStore } from '@/lib/file-store';

/**
 * #156: a stored file is on disk, file and directory entry, before store()
 * returns; the database commits the row that names it only after.
 */
describe('the file store', () => {
  afterEach(() => vi.restoreAllMocks());

  it('syncs the file and its directory before it says the file is stored', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'store-'));
    const key = { version: 1, key: new Uint8Array(32).fill(7) };
    const store = createFileStore({ dir, current: key, keys: [key] });
    const synced: string[] = [];
    const open = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation((async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args);
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        synced.push(path.relative(dir, String(args[0])) || '.');
        return sync();
      };
      return handle;
    }) as typeof fs.open);
    const record = await store.store(new TextEncoder().encode('%PDF-1.7 a report'));
    expect(synced).toEqual(process.platform === 'win32' ? [record.path] : [record.path, '.']);
    expect(new TextDecoder().decode(await store.read(record))).toBe('%PDF-1.7 a report');
  });
});
