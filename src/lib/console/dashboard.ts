import 'server-only';
import type { SessionUser } from '@/auth';
import { db } from '@/lib/db';
import type { ChainWriteKind, ChainWriteMode, ChainWriteStatus } from '@/generated/prisma/enums';
import { lastDays, lastMonths } from './periods';

/**
 * The dashboard's figures, each scoped to the caller's firm and each a count
 * over the firm's own rows. Days and months are UTC, so the figures do not
 * move with the reader's time zone.
 */

export const ANCHOR_MONTHS = 12;
export const LOOKUP_DAYS = 30;

const KINDS = ['ANCHOR', 'ANCHOR_COPY', 'REVOKE'] as const satisfies readonly ChainWriteKind[];

export type AnchorMonth = { month: string } & Record<ChainWriteKind, number>;

/**
 * Chain writes that reached a finalized block, per month and kind: read from
 * the audit log's `anchor.final` and `anchor.linked` events, whose time is
 * written once and never changes. Dry runs never finalize, so they are not
 * here.
 */
export async function anchorsPerMonth(user: SessionUser, now = new Date()): Promise<AnchorMonth[]> {
  const months = lastMonths(now, ANCHOR_MONTHS);
  const since = new Date(`${months[0]}-01T00:00:00.000Z`);
  const rows = await db().$queryRaw<{ month: string; kind: ChainWriteKind; count: bigint }[]>`
    SELECT to_char(date_trunc('month', e."at"::timestamptz AT TIME ZONE 'UTC'), 'YYYY-MM') AS month, w."kind" AS kind, count(*) AS count
    FROM "AuditEvent" e
    JOIN "ChainWrite" w ON w."id" = e."subjectId"
    WHERE e."orgId" = ${user.orgId}
      AND e."subjectType" = 'ChainWrite'
      AND e."action" IN ('anchor.final', 'anchor.linked')
      AND e."at"::timestamptz >= ${since}
    GROUP BY 1, 2`;
  const byMonth = new Map(months.map((month) => [month, { month, ANCHOR: 0, ANCHOR_COPY: 0, REVOKE: 0 } as AnchorMonth]));
  for (const row of rows) {
    const entry = byMonth.get(row.month);
    if (entry && (KINDS as readonly string[]).includes(row.kind)) entry[row.kind] = Number(row.count);
  }
  return [...byMonth.values()];
}

export type WriteCounts = Record<ChainWriteStatus, number>;

/** Every journal row the firm has, by status, live and dry run apart. */
export async function writesByStatus(user: SessionUser): Promise<Record<Exclude<ChainWriteMode, 'DISABLED'>, WriteCounts>> {
  const empty = (): WriteCounts => ({ INTENT: 0, SIMULATED: 0, BROADCAST: 0, FINAL: 0, FAILED: 0, INDETERMINATE: 0 });
  const result = { LIVE: empty(), DRY_RUN: empty() };
  const groups = await db().chainWrite.groupBy({
    by: ['mode', 'status'],
    where: { reportVersion: { engagement: { client: { orgId: user.orgId } } } },
    _count: { _all: true },
  });
  for (const group of groups) {
    // A row is written in the mode it was approved under, and DISABLED approves nothing.
    if (group.mode !== 'DISABLED') result[group.mode][group.status] = group._count._all;
  }
  return result;
}

export interface LookupDay {
  day: string;
  count: number;
}

/** Lookups of the firm's families' latest-version page, per UTC day, zero where there were none. */
export async function lookupsPerDay(user: SessionUser, now = new Date()): Promise<LookupDay[]> {
  const days = lastDays(now, LOOKUP_DAYS);
  const rows = await db().lookupCount.findMany({
    where: { orgId: user.orgId, day: { gte: new Date(`${days[0]}T00:00:00.000Z`) } },
    select: { day: true, count: true },
  });
  const counts = new Map(rows.map((r) => [r.day.toISOString().slice(0, 10), r.count]));
  return days.map((day) => ({ day, count: counts.get(day) ?? 0 }));
}
