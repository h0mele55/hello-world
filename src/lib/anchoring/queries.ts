import 'server-only';
import type { SessionUser } from '@/auth';
import { ChainError } from '@/lib/chain/errors';
import { db } from '@/lib/db';
import { AnchoringError } from './errors';
import { anchorTargetFromEnv, type AnchorTarget } from './target';

/** The configured target, or why there is none: a page shows the reason rather than failing. */
export function resolveAnchorTarget(): { target: AnchorTarget | null; problem: string | null } {
  try {
    const target = anchorTargetFromEnv();
    return { target, problem: target ? null : 'NOT_CONFIGURED' };
  } catch (error) {
    if (error instanceof ChainError) return { target: null, problem: error.code };
    throw error;
  }
}

/** A version's anchor and its journal, newest write first. Scoped to the caller's firm. */
export async function getVersionAnchoring(user: SessionUser, versionId: string) {
  const version = await db().reportVersion.findFirst({
    where: { id: versionId, engagement: { client: { orgId: user.orgId } } },
    select: {
      id: true,
      recordId: true,
      anchorTxHash: true,
      anchorBlock: true,
      anchorOnly: true,
      copyRecordId: true,
      copyTxHash: true,
      copyBlock: true,
      certificateStoredFileId: true,
      approvedAt: true,
      approvedBy: { select: { email: true } },
      engagement: { select: { client: { select: { org: { select: { chainWriteMode: true } } } } } },
      chainWrites: {
        orderBy: { createdAt: 'desc' },
        select: { id: true, kind: true, mode: true, status: true, chainId: true, nonce: true, txHash: true, replacedTxHashes: true, blockNumber: true, error: true, createdAt: true },
      },
    },
  });
  if (!version) throw new AnchoringError('NOT_FOUND');
  return {
    recordId: version.recordId,
    anchorTxHash: version.anchorTxHash,
    anchorBlock: version.anchorBlock?.toString() ?? null,
    anchorOnly: version.anchorOnly,
    copyRecordId: version.copyRecordId,
    copyTxHash: version.copyTxHash,
    copyBlock: version.copyBlock?.toString() ?? null,
    hasCertificate: version.certificateStoredFileId !== null,
    approvedAt: version.approvedAt,
    approvedBy: version.approvedBy?.email ?? null,
    mode: version.engagement.client.org.chainWriteMode,
    writes: version.chainWrites.map((w) => ({ ...w, blockNumber: w.blockNumber?.toString() ?? null })),
  };
}

/** The worker's last balance check for the configured issuer key, if any. */
export async function getIssuerKeyStatus(target: AnchorTarget | null) {
  if (!target) return null;
  return db().issuerKeyStatus.findUnique({ where: { chainId_address: { chainId: target.chainId, address: target.issuer } } });
}
