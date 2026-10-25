import 'server-only';
import { db } from '@/lib/db';

const FAMILY_ID = /^0x[0-9a-f]{64}$/;

/**
 * Counts one lookup of a family's latest-version page for the firm that
 * issued the family, on today's UTC date. Only a family this server issued is
 * counted; anything else changes nothing. One statement, so two lookups at
 * once both count.
 *
 * Never throws: a lookup is public and is answered from the chain (rule 5),
 * so a database that is down must not cost the visitor their answer. The log
 * line names no family id and no address.
 */
export async function recordLookup(familyId: string): Promise<void> {
  const id = familyId.toLowerCase();
  if (!FAMILY_ID.test(id)) return;
  try {
    await db().$executeRaw`
      INSERT INTO "LookupCount" ("orgId", "day", "count")
      SELECT c."orgId", (now() AT TIME ZONE 'UTC')::date, 1
      FROM "Engagement" e JOIN "Client" c ON c."id" = e."clientId"
      WHERE e."familyId" = ${id}
      ON CONFLICT ("orgId", "day") DO UPDATE SET "count" = "LookupCount"."count" + 1`;
  } catch (error) {
    console.error(`Lookup not counted: ${error instanceof Error ? error.name : typeof error}`);
  }
}
