import 'server-only';
import path from 'node:path';
import { createFileStore, type FileStore, type StoredFileRecord } from './file-store';
import { currentSealingKey, sealingKeys } from './keys';
import type { Bytes } from './sealed';
import { serverEnv } from './server-env';

export { StoredFileError, type StoredFileRecord } from './file-store';

/** The web app's file store, configured from serverEnv (see src/lib/file-store.ts). */
function fileStore(): FileStore {
  // Runtime data, not source: keep the bundler from tracing it.
  const dir = path.resolve(/*turbopackIgnore: true*/ process.cwd(), serverEnv().FILE_STORAGE_DIR);
  return createFileStore({ dir, current: currentSealingKey(), keys: sealingKeys() });
}

export const storeFile = (bytes: Uint8Array): Promise<StoredFileRecord> => fileStore().store(bytes);
export const readStoredFile = (record: StoredFileRecord): Promise<Bytes> => fileStore().read(record);
export const discardStoredFile = (relativePath: string): Promise<void> => fileStore().discard(relativePath);
