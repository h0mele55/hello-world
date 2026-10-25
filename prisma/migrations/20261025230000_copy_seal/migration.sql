-- #70: the distribution copy may carry the firm's electronic seal (PAdES B-T); this is its timestamp's time.
ALTER TABLE "ReportVersion" ADD COLUMN "copySealedAt" TIMESTAMP(3);

-- Only a copy that exists can be sealed, and an anchor-only version never has one.
ALTER TABLE "ReportVersion" ADD CONSTRAINT "ReportVersion_seal_needs_copy" CHECK ("copySealedAt" IS NULL OR ("copyDocHash" IS NOT NULL AND NOT "anchorOnly"));
