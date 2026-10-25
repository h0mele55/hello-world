import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { sha256 } from './commitments';
import { decrypt, encrypt, type Bytes, type SealingKey } from './sealed';

/**
 * PDFs encrypted at rest. The ciphertext lives on disk under one directory;
 * the IV, tag, key version and plaintext hash live in the StoredFile row. The
 * file's own path is the additional authenticated data, so swapping two files
 * on disk makes both fail to open.
 *
 * A factory, so the web app (src/lib/storage.ts, configured from serverEnv)
 * and the anchoring worker (configured from its own environment) share one
 * implementation without the worker needing the web app's secrets.
 */

export interface StoredFileRecord {
  path: string;
  iv: Bytes;
  authTag: Bytes;
  keyVersion: number;
  sha256: string;
  size: number;
}

export class StoredFileError extends Error {
  constructor(readonly code: 'HASH_MISMATCH' | 'KEY_VERSION_UNKNOWN') {
    super(`Stored file cannot be read: ${code}`);
    this.name = 'StoredFileError';
  }
}

export interface FileStore {
  store(bytes: Uint8Array): Promise<StoredFileRecord>;
  /** Decrypts a stored file and checks it is still byte-for-byte what was stored. */
  read(record: StoredFileRecord): Promise<Bytes>;
  /** Removes a file written for a change that then failed. */
  discard(relativePath: string): Promise<void>;
}

export function createFileStore(options: { dir: string; current: SealingKey; keys: SealingKey[] }): FileStore {
  const { dir, current, keys } = options;
  const contextOf = (relativePath: string) => `stored-file:${relativePath}`;
  return {
    async store(bytes) {
      const relativePath = `${randomUUID()}.bin`;
      const sealed = encrypt(current, bytes, contextOf(relativePath));
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      // 'wx': never overwrite an existing file.
      await fs.writeFile(path.join(dir, relativePath), sealed.ciphertext, { flag: 'wx', mode: 0o600 });
      return { path: relativePath, iv: sealed.iv, authTag: sealed.authTag, keyVersion: current.version, sha256: sha256(bytes), size: bytes.length };
    },
    async read(record) {
      const key = keys.find((k) => k.version === record.keyVersion);
      if (!key) throw new StoredFileError('KEY_VERSION_UNKNOWN');
      const ciphertext = await fs.readFile(path.join(dir, path.basename(record.path)));
      const bytes = decrypt(key.key, { iv: record.iv, authTag: record.authTag, ciphertext }, contextOf(record.path));
      if (sha256(bytes) !== record.sha256) throw new StoredFileError('HASH_MISMATCH');
      return bytes;
    },
    async discard(relativePath) {
      await fs.rm(path.join(dir, path.basename(relativePath)), { force: true });
    },
  };
}
