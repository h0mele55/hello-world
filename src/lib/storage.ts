import 'server-only';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { sha256 } from './commitments';
import { currentSealingKey, sealingKeys } from './keys';
import { decrypt, encrypt, type Bytes } from './sealed';
import { serverEnv } from './server-env';

/**
 * Uploaded PDFs, encrypted at rest. The ciphertext lives on disk under
 * FILE_STORAGE_DIR; the IV, tag, key version and plaintext hash live in the
 * StoredFile row. The file's own path is the additional authenticated data,
 * so swapping two files on disk makes both fail to open.
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

function storageDir(): string {
  return path.resolve(process.cwd(), serverEnv().FILE_STORAGE_DIR);
}

const contextOf = (relativePath: string) => `stored-file:${relativePath}`;

export async function storeFile(bytes: Uint8Array): Promise<StoredFileRecord> {
  const key = currentSealingKey();
  const relativePath = `${randomUUID()}.bin`;
  const sealed = encrypt(key, bytes, contextOf(relativePath));
  await fs.mkdir(storageDir(), { recursive: true, mode: 0o700 });
  // 'wx': never overwrite an existing file.
  await fs.writeFile(path.join(storageDir(), relativePath), sealed.ciphertext, { flag: 'wx', mode: 0o600 });
  return { path: relativePath, iv: sealed.iv, authTag: sealed.authTag, keyVersion: key.version, sha256: sha256(bytes), size: bytes.length };
}

/** Decrypts a stored file and checks it is still byte-for-byte what was uploaded. */
export async function readStoredFile(record: StoredFileRecord): Promise<Bytes> {
  const key = sealingKeys().find((k) => k.version === record.keyVersion);
  if (!key) throw new StoredFileError('KEY_VERSION_UNKNOWN');
  const ciphertext = await fs.readFile(path.join(storageDir(), path.basename(record.path)));
  const bytes = decrypt(key.key, { iv: record.iv, authTag: record.authTag, ciphertext }, contextOf(record.path));
  if (sha256(bytes) !== record.sha256) throw new StoredFileError('HASH_MISMATCH');
  return bytes;
}

/** Removes a file written for an upload that then failed. */
export async function discardStoredFile(relativePath: string): Promise<void> {
  await fs.rm(path.join(storageDir(), path.basename(relativePath)), { force: true });
}
