-- CreateEnum
CREATE TYPE "RevocationReason" AS ENUM ('WITHDRAWN', 'ISSUED_IN_ERROR', 'SUPERSEDED_AND_WITHDRAWN', 'OTHER');

-- CreateEnum
CREATE TYPE "RevocationStatus" AS ENUM ('REQUESTED', 'APPROVED', 'REVOKED', 'REJECTED', 'WITHDRAWN');

-- AlterEnum
ALTER TYPE "VersionStatus" ADD VALUE 'REVOKED';

-- AlterTable
ALTER TABLE "ReportVersion" ADD COLUMN     "revokedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "Revocation" (
    "id" TEXT NOT NULL,
    "reportVersionId" TEXT NOT NULL,
    "reason" "RevocationReason" NOT NULL,
    "note" BYTEA NOT NULL,
    "status" "RevocationStatus" NOT NULL DEFAULT 'REQUESTED',
    "requestedById" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "closedById" TEXT,
    "closedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "Revocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Revocation_reportVersionId_idx" ON "Revocation"("reportVersionId");

-- CreateIndex
CREATE INDEX "Revocation_requestedById_idx" ON "Revocation"("requestedById");

-- CreateIndex
CREATE INDEX "Revocation_approvedById_idx" ON "Revocation"("approvedById");

-- CreateIndex
CREATE INDEX "Revocation_closedById_idx" ON "Revocation"("closedById");

-- AddForeignKey
ALTER TABLE "Revocation" ADD CONSTRAINT "Revocation_reportVersionId_fkey" FOREIGN KEY ("reportVersionId") REFERENCES "ReportVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Revocation" ADD CONSTRAINT "Revocation_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Revocation" ADD CONSTRAINT "Revocation_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Revocation" ADD CONSTRAINT "Revocation_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A revoked version keeps the approval and the record it had, and says when it was revoked.
ALTER TABLE "ReportVersion" DROP CONSTRAINT "ReportVersion_approved_has_approver";
ALTER TABLE "ReportVersion" ADD CONSTRAINT "ReportVersion_approved_has_approver"
  CHECK ("status"::text NOT IN ('APPROVED', 'ANCHORED', 'COMPLETE', 'REVOKED') OR ("approvedById" IS NOT NULL AND "approvedAt" IS NOT NULL));
ALTER TABLE "ReportVersion" DROP CONSTRAINT "ReportVersion_anchored_has_record";
ALTER TABLE "ReportVersion" ADD CONSTRAINT "ReportVersion_anchored_has_record"
  CHECK ("status"::text NOT IN ('ANCHORED', 'COMPLETE', 'REVOKED') OR ("recordId" IS NOT NULL AND "anchorBlock" IS NOT NULL));
ALTER TABLE "ReportVersion" ADD CONSTRAINT "ReportVersion_revoked_has_time"
  CHECK ("status"::text <> 'REVOKED' OR "revokedAt" IS NOT NULL);

-- Four eyes (CLAUDE.md rule 6): whoever asked for a revocation never approves it.
ALTER TABLE "Revocation" ADD CONSTRAINT "Revocation_four_eyes"
  CHECK ("approvedById" IS NULL OR "approvedById" <> "requestedById");
ALTER TABLE "Revocation" ADD CONSTRAINT "Revocation_approved_has_approver"
  CHECK ("status"::text NOT IN ('APPROVED', 'REVOKED') OR ("approvedById" IS NOT NULL AND "approvedAt" IS NOT NULL));
ALTER TABLE "Revocation" ADD CONSTRAINT "Revocation_revoked_has_time"
  CHECK ("status"::text <> 'REVOKED' OR "revokedAt" IS NOT NULL);
ALTER TABLE "Revocation" ADD CONSTRAINT "Revocation_closed_has_closer"
  CHECK ("status"::text NOT IN ('REJECTED', 'WITHDRAWN') OR ("closedById" IS NOT NULL AND "closedAt" IS NOT NULL));

-- One open revocation per version: a second request waits until the first is closed.
CREATE UNIQUE INDEX "Revocation_one_open_per_version" ON "Revocation"("reportVersionId") WHERE "status" IN ('REQUESTED', 'APPROVED', 'REVOKED');
