import 'server-only';
import type { SessionUser } from '@/auth';
import { db } from '@/lib/db';
import type { ReasonCode, ReportType, VersionStatus } from '@/generated/prisma/enums';

/**
 * What the console's lists read. Every query is scoped to the caller's firm;
 * a client or engagement of another firm reads as absent (null), never as
 * forbidden.
 */

/** The client list loads at most this many clients; past it, the page says so. */
export const CLIENT_LIST_CAP = 1000;

const dateOnly = (d: Date) => d.toISOString().slice(0, 10);
const IN_PROGRESS: readonly VersionStatus[] = ['DRAFT', 'CONFIRMED', 'APPROVED', 'ANCHORED'];

export interface ClientRow {
  id: string;
  name: string;
  registrationNumber: string;
  country: string;
  engagements: number;
  /** Versions not yet complete: a draft, waiting for approval, or on its way to the chain. */
  inProgress: number;
  /** ISO time of the newest version, or of the client's creation if it has none. */
  lastActivity: string;
}

export async function listClients(user: SessionUser): Promise<{ clients: ClientRow[]; truncated: boolean }> {
  const rows = await db().client.findMany({
    where: { orgId: user.orgId },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
    // One past the cap, so a truncated list is a fact the page holds, not a guess.
    take: CLIENT_LIST_CAP + 1,
    select: {
      id: true,
      name: true,
      registrationNumber: true,
      country: true,
      createdAt: true,
      engagements: { select: { versions: { select: { status: true, createdAt: true } } } },
    },
  });
  const clients = rows.slice(0, CLIENT_LIST_CAP).map((c) => {
    const versions = c.engagements.flatMap((e) => e.versions);
    const newest = versions.reduce((latest, v) => (v.createdAt > latest ? v.createdAt : latest), c.createdAt);
    return {
      id: c.id,
      name: c.name,
      registrationNumber: c.registrationNumber,
      country: c.country,
      engagements: c.engagements.length,
      inProgress: versions.filter((v) => IN_PROGRESS.includes(v.status)).length,
      lastActivity: newest.toISOString(),
    };
  });
  return { clients, truncated: rows.length > CLIENT_LIST_CAP };
}

export interface ClientEngagementRow {
  id: string;
  engagementRef: string;
  periodEnd: string;
  reportType: ReportType;
  versions: number;
  /** The status of its highest version, or null before the first upload. */
  latestStatus: VersionStatus | null;
  latestVersion: number | null;
}

export async function getClient(user: SessionUser, clientId: string) {
  const client = await db().client.findFirst({
    where: { id: clientId, orgId: user.orgId },
    select: {
      id: true,
      name: true,
      registrationNumber: true,
      country: true,
      engagements: {
        orderBy: [{ periodEnd: 'desc' }, { createdAt: 'desc' }],
        select: {
          id: true,
          engagementRef: true,
          periodEnd: true,
          reportType: true,
          versions: { orderBy: { version: 'desc' }, select: { version: true, status: true } },
        },
      },
    },
  });
  if (!client) return null;
  const engagements: ClientEngagementRow[] = client.engagements.map((e) => ({
    id: e.id,
    engagementRef: e.engagementRef,
    periodEnd: dateOnly(e.periodEnd),
    reportType: e.reportType,
    versions: e.versions.length,
    latestStatus: e.versions[0]?.status ?? null,
    latestVersion: e.versions[0]?.version ?? null,
  }));
  return { id: client.id, name: client.name, registrationNumber: client.registrationNumber, country: client.country, engagements };
}

export interface TimelineVersion {
  id: string;
  version: number;
  status: VersionStatus;
  reasonCode: ReasonCode;
  anchorOnly: boolean;
  uploadedAt: string;
  preparedBy: string;
  approvedBy: string | null;
  approvedAt: string | null;
  completedAt: string | null;
  /** The chain the original's final anchor is on, for explorer links. */
  chainId: number | null;
  recordId: string | null;
  anchorTxHash: string | null;
  anchorBlock: string | null;
  copyTxHash: string | null;
  copyBlock: string | null;
}

/** An engagement's versions, newest first, with who did what and where each landed. */
export async function getEngagementTimeline(user: SessionUser, engagementId: string) {
  const engagement = await db().engagement.findFirst({
    where: { id: engagementId, client: { orgId: user.orgId } },
    select: {
      id: true,
      engagementRef: true,
      periodEnd: true,
      reportType: true,
      familyId: true,
      client: { select: { id: true, name: true, registrationNumber: true } },
      versions: {
        orderBy: { version: 'desc' },
        select: {
          id: true,
          version: true,
          status: true,
          reasonCode: true,
          anchorOnly: true,
          createdAt: true,
          preparedBy: { select: { email: true } },
          approvedBy: { select: { email: true } },
          approvedAt: true,
          completedAt: true,
          recordId: true,
          anchorTxHash: true,
          anchorBlock: true,
          copyTxHash: true,
          copyBlock: true,
          chainWrites: { where: { kind: 'ANCHOR', status: 'FINAL' }, select: { chainId: true }, take: 1 },
        },
      },
    },
  });
  if (!engagement) return null;
  const versions: TimelineVersion[] = engagement.versions.map((v) => ({
    id: v.id,
    version: v.version,
    status: v.status,
    reasonCode: v.reasonCode,
    anchorOnly: v.anchorOnly,
    uploadedAt: v.createdAt.toISOString(),
    preparedBy: v.preparedBy.email,
    approvedBy: v.approvedBy?.email ?? null,
    approvedAt: v.approvedAt?.toISOString() ?? null,
    completedAt: v.completedAt?.toISOString() ?? null,
    chainId: v.chainWrites[0]?.chainId ?? null,
    recordId: v.recordId,
    anchorTxHash: v.anchorTxHash,
    anchorBlock: v.anchorBlock?.toString() ?? null,
    copyTxHash: v.copyTxHash,
    copyBlock: v.copyBlock?.toString() ?? null,
  }));
  return {
    id: engagement.id,
    engagementRef: engagement.engagementRef,
    periodEnd: dateOnly(engagement.periodEnd),
    reportType: engagement.reportType,
    familyId: engagement.familyId,
    client: engagement.client,
    versions,
  };
}
