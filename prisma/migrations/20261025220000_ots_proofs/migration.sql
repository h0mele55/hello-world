-- #66: a second, independent timestamp of each version's manifest hash, on Bitcoin through OpenTimestamps.
CREATE TYPE "OtsStatus" AS ENUM ('PENDING', 'COMPLETE', 'BROKEN');

CREATE TABLE "OtsProof" (
    "id" TEXT NOT NULL,
    "reportVersionId" TEXT NOT NULL,
    "digest" TEXT NOT NULL,
    "proof" BYTEA NOT NULL,
    "status" "OtsStatus" NOT NULL DEFAULT 'PENDING',
    "calendars" TEXT[],
    "submittedAt" TIMESTAMP(3) NOT NULL,
    "checkedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "bitcoinHeight" INTEGER,
    "bitcoinBlockHash" TEXT,
    "bitcoinTime" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "OtsProof_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OtsProof_reportVersionId_key" ON "OtsProof"("reportVersionId");
CREATE UNIQUE INDEX "OtsProof_digest_key" ON "OtsProof"("digest");
CREATE INDEX "OtsProof_status_checkedAt_idx" ON "OtsProof"("status", "checkedAt");

ALTER TABLE "OtsProof" ADD CONSTRAINT "OtsProof_reportVersionId_fkey" FOREIGN KEY ("reportVersionId") REFERENCES "ReportVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The digest is a 32-byte hash, in lower-case hex.
ALTER TABLE "OtsProof" ADD CONSTRAINT "OtsProof_digest_shape" CHECK ("digest" ~ '^0x[0-9a-f]{64}$');
-- Kept only once at least two calendars took the digest.
ALTER TABLE "OtsProof" ADD CONSTRAINT "OtsProof_two_calendars" CHECK (cardinality("calendars") >= 2);
-- COMPLETE exactly when the block it reaches is recorded.
ALTER TABLE "OtsProof" ADD CONSTRAINT "OtsProof_complete_has_block" CHECK (
  ("status" = 'COMPLETE') = ("bitcoinHeight" IS NOT NULL AND "bitcoinBlockHash" IS NOT NULL AND "bitcoinTime" IS NOT NULL AND "completedAt" IS NOT NULL)
);
-- BROKEN names its reason.
ALTER TABLE "OtsProof" ADD CONSTRAINT "OtsProof_broken_has_reason" CHECK ("status" <> 'BROKEN' OR "lastError" IS NOT NULL);
