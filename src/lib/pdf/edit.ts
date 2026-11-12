import { z } from 'zod';
import { childScriptPath, runIsolated, type IsolationLimits } from './isolated';

/**
 * The incremental updates the worker writes into a stored PDF, made by
 * pdf-lib in an isolated child (edit-child.mjs, #154) rather than in the
 * worker, which holds the issuer key and the seal credentials. The answer is
 * checked here: it must be the file sent plus what was appended.
 */

export const EDIT_LIMITS: IsolationLimits = { timeoutMs: 60_000, heapMb: 512, memoryMb: 1024 };

export type PdfEdit =
  | { kind: 'stamp'; namespace: string; infoKeyPrefix: string; description: string; freshPacket: string; info: [string, string][] }
  | { kind: 'prepareSeal'; placeholder: number; contentsBytes: number; signingTime: string; reason: string; fieldName: string };

export type EditRefusal = 'ENCRYPTED' | 'ALREADY_STAMPED' | 'UNREADABLE' | 'RESOURCE_LIMIT' | 'NOT_INCREMENTAL';
export type EditResult = { ok: true; bytes: Uint8Array } | { ok: false; code: EditRefusal };

const Answer = z.union([
  z.strictObject({ ok: z.literal(true), bytes: z.instanceof(Uint8Array) }),
  z.strictObject({ ok: z.literal(false), code: z.enum(['ENCRYPTED', 'ALREADY_STAMPED', 'UNREADABLE']) }),
]);

export async function editPdf(bytes: Uint8Array, edit: PdfEdit, overrides: Partial<IsolationLimits> = {}): Promise<EditResult> {
  const outcome = await runIsolated(childScriptPath('edit-child.mjs'), { bytes, edit }, { ...EDIT_LIMITS, ...overrides });
  // Too slow or too large is the file's doing; a crash is a file it could not read.
  if (!outcome.ok) return { ok: false, code: outcome.reason === 'CRASHED' ? 'UNREADABLE' : 'RESOURCE_LIMIT' };
  const answer = Answer.safeParse(outcome.answer);
  if (!answer.success) return { ok: false, code: 'UNREADABLE' };
  if (!answer.data.ok) return answer.data;
  const edited = answer.data.bytes;
  if (edited.length <= bytes.length || !Buffer.from(edited.subarray(0, bytes.length)).equals(Buffer.from(bytes))) return { ok: false, code: 'NOT_INCREMENTAL' };
  return { ok: true, bytes: edited };
}
