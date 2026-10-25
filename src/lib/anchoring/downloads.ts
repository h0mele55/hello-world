import 'server-only';
import type { SessionUser } from '@/auth';
import { db } from '@/lib/db';
import type { Bytes } from '@/lib/sealed';
import { readStoredFile } from '@/lib/storage';
import { AnchoringError } from './errors';

/**
 * What a firm hands to recipients once a version is COMPLETE: the anchored
 * distribution copy, or, for an anchor-only version, its verification
 * certificate (to travel with the report as issued). Nothing before COMPLETE.
 */
export async function readDistributable(user: SessionUser, versionId: string, what: 'copy' | 'certificate'): Promise<{ bytes: Bytes; version: number }> {
  const version = await db().reportVersion.findFirst({
    where: { id: versionId, engagement: { client: { orgId: user.orgId } } },
    select: { version: true, status: true, anchorOnly: true, copyStoredFile: true, certificateStoredFile: true },
  });
  if (!version) throw new AnchoringError('NOT_FOUND');
  if (version.status !== 'COMPLETE') throw new AnchoringError('NOT_COMPLETE');
  const file = what === 'copy' ? version.copyStoredFile : version.certificateStoredFile;
  if (!file) throw new AnchoringError(what === 'copy' ? 'ANCHOR_ONLY' : 'NOT_FOUND');
  return { bytes: await readStoredFile(file), version: version.version };
}
