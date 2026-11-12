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

/** How many engagements /reports lists; past them it says so (#146). */
export const ENGAGEMENT_LIST_CAP = 200;

/** The user's firm's engagements, newest first, with their versions, and whether more were left out. */
export async function listEngagements(user: SessionUser): Promise<{ engagements: EngagementView[]; truncated: boolean }> {
  const rows = await db().engagement.findMany({
    where: { client: { orgId: user.orgId } },
    include,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    // One past the cap, so a cut list is a fact the page holds, not a guess.
    take: ENGAGEMENT_LIST_CAP + 1,
  });
  return { engagements: rows.slice(0, ENGAGEMENT_LIST_CAP).map(view), truncated: rows.length > ENGAGEMENT_LIST_CAP };
}
