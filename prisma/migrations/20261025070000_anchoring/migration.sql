-- CreateEnum
CREATE TYPE "ChainWriteMode" AS ENUM ('DISABLED', 'DRY_RUN', 'LIVE');

-- CreateEnum
CREATE TYPE "ChainWriteKind" AS ENUM ('ANCHOR', 'ANCHOR_COPY', 'REVOKE');

-- CreateEnum
CREATE TYPE "ChainWriteStatus" AS ENUM ('INTENT', 'SIMULATED', 'BROADCAST', 'FINAL', 'FAILED', 'INDETERMINATE');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "VersionStatus" ADD VALUE 'APPROVED';
ALTER TYPE "VersionStatus" ADD VALUE 'ANCHORED';
ALTER TYPE "VersionStatus" ADD VALUE 'COMPLETE';

-- AlterTable
ALTER TABLE "IssuerOrg" ADD COLUMN     "chainWriteMode" "ChainWriteMode" NOT NULL DEFAULT 'DISABLED';

-- AlterTable
ALTER TABLE "ReportVersion" ADD COLUMN     "anchorBlock" BIGINT,
ADD COLUMN     "anchorTxHash" TEXT,
ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "approvedById" TEXT,
ADD COLUMN     "recordId" TEXT;

-- CreateTable
CREATE TABLE "ChainWrite" (
    "id" TEXT NOT NULL,
    "reportVersionId" TEXT NOT NULL,
    "kind" "ChainWriteKind" NOT NULL,
    "status" "ChainWriteStatus" NOT NULL DEFAULT 'INTENT',
    "mode" "ChainWriteMode" NOT NULL,
    "chainId" INTEGER NOT NULL,
    "registry" TEXT NOT NULL,
    "issuer" TEXT NOT NULL,
    "parentId" TEXT,
    "recordId" TEXT,
    "nonce" INTEGER,
    "txHash" TEXT,
    "replacedTxHashes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "gasLimit" TEXT,
    "maxFeePerGas" TEXT,
    "maxPriorityFeePerGas" TEXT,
    "blockNumber" BIGINT,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "broadcastAt" TIMESTAMP(3),
    "leaseUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChainWrite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" BIGSERIAL NOT NULL,
    "orgId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "at" TEXT NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "prevHash" TEXT NOT NULL,
    "hash" TEXT NOT NULL,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IssuerKeyStatus" (
    "chainId" INTEGER NOT NULL,
    "address" TEXT NOT NULL,
    "balanceWei" TEXT NOT NULL,
    "low" BOOLEAN NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IssuerKeyStatus_pkey" PRIMARY KEY ("chainId","address")
);

-- CreateIndex
CREATE INDEX "ChainWrite_status_leaseUntil_idx" ON "ChainWrite"("status", "leaseUntil");

-- CreateIndex
CREATE INDEX "ChainWrite_reportVersionId_idx" ON "ChainWrite"("reportVersionId");

-- CreateIndex
CREATE INDEX "ChainWrite_chainId_issuer_idx" ON "ChainWrite"("chainId", "issuer");

-- CreateIndex
CREATE UNIQUE INDEX "AuditEvent_hash_key" ON "AuditEvent"("hash");

-- CreateIndex
CREATE UNIQUE INDEX "AuditEvent_orgId_seq_key" ON "AuditEvent"("orgId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "ReportVersion_recordId_key" ON "ReportVersion"("recordId");

-- CreateIndex
CREATE INDEX "ReportVersion_approvedById_idx" ON "ReportVersion"("approvedById");

-- AddForeignKey
ALTER TABLE "ReportVersion" ADD CONSTRAINT "ReportVersion_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChainWrite" ADD CONSTRAINT "ChainWrite_reportVersionId_fkey" FOREIGN KEY ("reportVersionId") REFERENCES "ReportVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "IssuerOrg"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ── Written by hand: rules the schema language cannot express ──
-- Enum values added above are compared as text: Postgres refuses a new enum
-- value in the transaction that added it.

-- CLAUDE.md rule 6: the person who approves an anchor is neither the preparer
-- nor the person who confirmed the opinion, and nothing reaches APPROVED or
-- beyond without an approver recorded.
ALTER TABLE "ReportVersion" ADD CONSTRAINT "ReportVersion_four_eyes"
  CHECK ("approvedById" IS NULL OR ("approvedById" <> "preparedById" AND "approvedById" <> COALESCE("confirmedById", '')));
ALTER TABLE "ReportVersion" ADD CONSTRAINT "ReportVersion_approved_has_approver"
  CHECK ("status"::text NOT IN ('APPROVED', 'ANCHORED', 'COMPLETE') OR ("approvedById" IS NOT NULL AND "approvedAt" IS NOT NULL));

-- At most one live write per version and kind: a second anchor of the same
-- version cannot be journalled while the first is neither FAILED nor a DRY_RUN
-- simulation.
CREATE UNIQUE INDEX "ChainWrite_one_live_per_kind" ON "ChainWrite"("reportVersionId", "kind") WHERE "status" NOT IN ('FAILED', 'SIMULATED');

-- One journal row per nonce of an issuer key: two workers that both picked a
-- nonce cannot both record it, so the second never signs or sends.
CREATE UNIQUE INDEX "ChainWrite_one_row_per_nonce" ON "ChainWrite"("chainId", "issuer", "nonce") WHERE "nonce" IS NOT NULL;

-- The audit log is append-only: refuse every UPDATE and DELETE.
CREATE FUNCTION audit_event_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AuditEvent is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AuditEvent_append_only"
  BEFORE UPDATE OR DELETE ON "AuditEvent"
  FOR EACH ROW EXECUTE FUNCTION audit_event_append_only();
