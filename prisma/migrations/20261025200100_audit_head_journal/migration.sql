-- #94: every journal row names its firm, and an AUDIT_HEAD row writes the
-- firm's audit-log head rather than a report version.

ALTER TABLE "ChainWrite" ADD COLUMN "orgId" TEXT;
UPDATE "ChainWrite" w
   SET "orgId" = c."orgId"
  FROM "ReportVersion" v
  JOIN "Engagement" e ON e."id" = v."engagementId"
  JOIN "Client" c ON c."id" = e."clientId"
 WHERE v."id" = w."reportVersionId";
ALTER TABLE "ChainWrite" ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "ChainWrite" ADD CONSTRAINT "ChainWrite_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "IssuerOrg"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "ChainWrite_orgId_kind_idx" ON "ChainWrite"("orgId", "kind");

ALTER TABLE "ChainWrite" ALTER COLUMN "reportVersionId" DROP NOT NULL;
ALTER TABLE "ChainWrite" ADD COLUMN "auditHead" TEXT;

-- An AUDIT_HEAD row, and only one, has no report version and carries a head.
ALTER TABLE "ChainWrite" ADD CONSTRAINT "ChainWrite_audit_head_shape" CHECK (
  ("kind" = 'AUDIT_HEAD') = ("reportVersionId" IS NULL)
  AND ("kind" = 'AUDIT_HEAD') = ("auditHead" IS NOT NULL)
);

-- One head in flight per firm, chain and registry: the next night's check
-- queues another only once this one has settled.
CREATE UNIQUE INDEX "ChainWrite_one_audit_head_in_flight" ON "ChainWrite"("orgId", "chainId", "registry")
  WHERE "kind" = 'AUDIT_HEAD' AND "status" IN ('INTENT', 'BROADCAST', 'INDETERMINATE');

-- What the nightly check found on chain.
ALTER TABLE "AuditChainCheck" ADD COLUMN "chainHeads" INTEGER;
ALTER TABLE "AuditChainCheck" ADD COLUMN "chainHeadAt" TIMESTAMP(3);

-- A failed check names the event to blame, except when no event is: a head on
-- chain the log lacks, or a chain that could not be read.
ALTER TABLE "AuditChainCheck" DROP CONSTRAINT "AuditChainCheck_outcome";
ALTER TABLE "AuditChainCheck" ADD CONSTRAINT "AuditChainCheck_outcome" CHECK (
  ("ok" AND "head" IS NOT NULL AND "brokenSeq" IS NULL AND "reason" IS NULL)
  OR (NOT "ok" AND "reason" IS NOT NULL AND ("brokenSeq" IS NOT NULL OR "reason" IN ('ANCHORED_HEAD_MISSING', 'CHAIN_UNREADABLE')))
);
