import 'server-only';
import type { SessionUser } from '@/auth';
import { db } from '@/lib/db';
import type { Prisma } from '@/generated/prisma/client';

const include = {
  client: true,
  versions: { select: { id: true, version: true, status: true, anchorOnly: true, createdAt: true }, orderBy: { version: 'asc' } },
} satisfies Prisma.EngagementInclude;

type Row = Prisma.EngagementGetPayload<{ include: typeof include }>;

function view(e: Row) {
  return {
    id: e.id,
    clientName: e.client.name,
    registrationNumber: e.client.registrationNumber,
    country: e.client.country,
    engagementRef: e.engagementRef,
    periodEnd: e.periodEnd.toISOString().slice(0, 10),
    reportType: e.reportType,
    versions: e.versions,
  };
}

export type EngagementView = ReturnType<typeof view>;

/** The user's firm's engagements, newest first, with their versions. */
export async function listEngagements(user: SessionUser): Promise<EngagementView[]> {
  const rows = await db().engagement.findMany({ where: { client: { orgId: user.orgId } }, include, orderBy: { createdAt: 'desc' }, take: 200 });
  return rows.map(view);
}
