-- A scheduled or revoked request was approved and knows when it takes effect;
-- a cancelled one was approved and says when it was found cancelled. Nobody
-- in the firm closes a cancelled one: the registry's owner cancelled it on chain.
ALTER TABLE "Revocation" DROP CONSTRAINT "Revocation_approved_has_approver";
ALTER TABLE "Revocation" ADD CONSTRAINT "Revocation_approved_has_approver"
  CHECK ("status"::text NOT IN ('APPROVED', 'SCHEDULED', 'REVOKED', 'CANCELLED') OR ("approvedById" IS NOT NULL AND "approvedAt" IS NOT NULL));
ALTER TABLE "Revocation" ADD CONSTRAINT "Revocation_scheduled_has_time"
  CHECK ("status"::text NOT IN ('SCHEDULED', 'REVOKED', 'CANCELLED') OR "effectiveAt" IS NOT NULL);
ALTER TABLE "Revocation" ADD CONSTRAINT "Revocation_cancelled_has_time"
  CHECK ("status"::text <> 'CANCELLED' OR ("closedAt" IS NOT NULL AND "closedById" IS NULL));

-- One open revocation per version: a scheduled one is still open.
DROP INDEX "Revocation_one_open_per_version";
CREATE UNIQUE INDEX "Revocation_one_open_per_version" ON "Revocation"("reportVersionId") WHERE "status" IN ('REQUESTED', 'APPROVED', 'SCHEDULED', 'REVOKED');

-- A cancelled revocation leaves its REVOKE write FINAL, and the firm may ask
-- again, so a version can have several REVOKE writes over time: one in flight
-- at a time. ANCHOR and ANCHOR_COPY keep one live write per version.
DROP INDEX "ChainWrite_one_live_per_kind";
CREATE UNIQUE INDEX "ChainWrite_one_live_per_kind" ON "ChainWrite"("reportVersionId", "kind") WHERE "status" NOT IN ('FAILED', 'SIMULATED') AND "kind" <> 'REVOKE';
CREATE UNIQUE INDEX "ChainWrite_one_revoke_in_flight" ON "ChainWrite"("reportVersionId") WHERE "kind" = 'REVOKE' AND "status" IN ('INTENT', 'BROADCAST', 'INDETERMINATE');
