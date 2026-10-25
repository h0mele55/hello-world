import 'server-only';
import type { SealingKey } from './sealed';
import { serverEnv } from './server-env';

/** The key new data is sealed under. */
export function currentSealingKey(): SealingKey {
  const env = serverEnv();
  return { key: env.FILE_ENCRYPTION_KEY, version: env.FILE_ENCRYPTION_KEY_VERSION };
}

/**
 * Every key data may have been sealed under. Only the current one for now; a
 * rotation adds the previous key here until a re-seal sweep has run (Phase 6).
 */
export function sealingKeys(): SealingKey[] {
  return [currentSealingKey()];
}
