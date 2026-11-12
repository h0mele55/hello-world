-- A failed check names the event to blame, except when no event is: a head on
-- chain the log lacks, a chain that could not be read, or a key that writes
-- the heads for another firm (#141).
ALTER TABLE "AuditChainCheck" DROP CONSTRAINT "AuditChainCheck_outcome";
ALTER TABLE "AuditChainCheck" ADD CONSTRAINT "AuditChainCheck_outcome" CHECK (
  ("ok" AND "head" IS NOT NULL AND "brokenSeq" IS NULL AND "reason" IS NULL)
  OR (NOT "ok" AND "reason" IS NOT NULL AND ("brokenSeq" IS NOT NULL OR "reason" IN ('ANCHORED_HEAD_MISSING', 'CHAIN_UNREADABLE', 'FIRM_MISMATCH')))
);
