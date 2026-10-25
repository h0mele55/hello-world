import 'server-only';
import type { SessionUser } from '@/auth';
import { AnchoringError } from '@/lib/anchoring/errors';
import { db } from '@/lib/db';

/**
 * A version's OpenTimestamps proof for the console (#66), scoped to the
 * caller's firm: where it stands, and the .ots file itself. A version of
 * another firm is NOT_FOUND.
 */
export async function getOtsProof(user: SessionUser, versionId: string) {
  const version = await db().reportVersion.findFirst({
    where: { id: versionId, engagement: { client: { orgId: user.orgId } } },
    select: {
      otsProof: {
        select: { status: true, calendars: true, submittedAt: true, checkedAt: true, lastError: true, bitcoinHeight: true, bitcoinBlockHash: true, bitcoinTime: true, completedAt: true },
      },
    },
  });
  if (!version) throw new AnchoringError('NOT_FOUND');
  return version.otsProof;
}

/** The .ots file of a version, whatever its state: a pending proof can be upgraded by anyone's client. */
export async function readOtsProof(user: SessionUser, versionId: string): Promise<{ bytes: Uint8Array<ArrayBuffer>; version: number }> {
  const version = await db().reportVersion.findFirst({
    where: { id: versionId, engagement: { client: { orgId: user.orgId } } },
    select: { version: true, otsProof: { select: { proof: true } } },
  });
  if (!version?.otsProof) throw new AnchoringError('NOT_FOUND');
  return { bytes: new Uint8Array(version.otsProof.proof), version: version.version };
}

/**
 * The proof of a manifest hash, for anyone (#66): the verifier asks for it by
 * the hash, which is public on chain, and the proof holds nothing else that
 * is not. Null when there is none.
 */
export async function publicOtsProof(manifestHash: string): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!/^0x[0-9a-f]{64}$/.test(manifestHash)) return null;
  const row = await db().otsProof.findUnique({ where: { digest: manifestHash }, select: { proof: true } });
  return row ? new Uint8Array(row.proof) : null;
}
