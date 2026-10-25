import 'server-only';
import { z } from 'zod';

/**
 * Server configuration, read and validated on first use rather than at import,
 * so `next build` needs none of it. Every secret comes from the environment;
 * .env.example lists the names (CLAUDE.md: secrets never enter the repository).
 */

/** A base64 key that decodes to at least `bytes` bytes. */
const base64Key = (bytes: number) =>
  z
    .string()
    .transform((value, ctx) => {
      const decoded = Buffer.from(value, 'base64');
      if (decoded.length < bytes || decoded.toString('base64').replace(/=+$/, '') !== value.replace(/=+$/, '')) {
        ctx.addIssue({ code: 'custom', message: `must be base64 of at least ${bytes} bytes` });
        return z.NEVER;
      }
      return new Uint8Array(decoded);
    });

const ServerEnv = z.object({
  DATABASE_URL: z.string().startsWith('postgres'),
  NEXTAUTH_SECRET: z.string().min(32),
  FILE_ENCRYPTION_KEY: base64Key(32).refine((key) => key.length === 32, 'must be exactly 32 bytes'),
  FILE_ENCRYPTION_KEY_VERSION: z.coerce.number().int().min(1).default(1),
  FILE_STORAGE_DIR: z.string().default('storage'),
  ISSUER_FAMILY_SECRET: base64Key(32),
});

export type ServerEnvironment = z.infer<typeof ServerEnv>;

let cached: ServerEnvironment | undefined;

export function serverEnv(): ServerEnvironment {
  if (cached) return cached;
  const parsed = ServerEnv.safeParse(process.env);
  if (!parsed.success) {
    // Names only; never echo a value.
    const names = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`Server configuration is invalid: ${names}`);
  }
  cached = parsed.data;
  return cached;
}
