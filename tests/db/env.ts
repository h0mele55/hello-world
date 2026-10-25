import { randomBytes } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

// Throwaway configuration for the database tests: fresh keys every run, files
// under a temporary directory, the database from TEST_DATABASE_URL.
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set');
process.env.DATABASE_URL = url;
process.env.NEXTAUTH_SECRET = randomBytes(32).toString('base64');
process.env.FILE_ENCRYPTION_KEY = randomBytes(32).toString('base64');
process.env.FILE_ENCRYPTION_KEY_VERSION = '1';
process.env.ISSUER_FAMILY_SECRET = randomBytes(32).toString('base64');
process.env.FILE_STORAGE_DIR = path.join(os.tmpdir(), `anchor-test-files-${process.pid}`);
