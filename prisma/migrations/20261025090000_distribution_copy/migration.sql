-- AlterTable
ALTER TABLE "ReportVersion" ADD COLUMN     "certificateStoredFileId" TEXT,
ADD COLUMN     "completedAt" TIMESTAMP(3),
ADD COLUMN     "copyBlock" BIGINT,
ADD COLUMN     "copyDocHash" TEXT,
ADD COLUMN     "copyRecordId" TEXT,
ADD COLUMN     "copyStoredFileId" TEXT,
ADD COLUMN     "copyTxHash" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "ReportVersion_copyDocHash_key" ON "ReportVersion"("copyDocHash");

-- CreateIndex
CREATE UNIQUE INDEX "ReportVersion_copyStoredFileId_key" ON "ReportVersion"("copyStoredFileId");

-- CreateIndex
CREATE UNIQUE INDEX "ReportVersion_copyRecordId_key" ON "ReportVersion"("copyRecordId");

-- CreateIndex
CREATE UNIQUE INDEX "ReportVersion_certificateStoredFileId_key" ON "ReportVersion"("certificateStoredFileId");

-- AddForeignKey
ALTER TABLE "ReportVersion" ADD CONSTRAINT "ReportVersion_copyStoredFileId_fkey" FOREIGN KEY ("copyStoredFileId") REFERENCES "StoredFile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportVersion" ADD CONSTRAINT "ReportVersion_certificateStoredFileId_fkey" FOREIGN KEY ("certificateStoredFileId") REFERENCES "StoredFile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ── Written by hand: rules the schema language cannot express ──

-- A signed or edit-protected file is never rewritten, so it has no copy (#74).
ALTER TABLE "ReportVersion" ADD CONSTRAINT "ReportVersion_anchor_only_no_copy"
  CHECK (NOT ("anchorOnly" AND ("copyDocHash" IS NOT NULL OR "copyStoredFileId" IS NOT NULL OR "copyRecordId" IS NOT NULL)));

-- ANCHORED or beyond names its record and block.
ALTER TABLE "ReportVersion" ADD CONSTRAINT "ReportVersion_anchored_has_record"
  CHECK ("status"::text NOT IN ('ANCHORED', 'COMPLETE') OR ("recordId" IS NOT NULL AND "anchorBlock" IS NOT NULL));

-- COMPLETE carries its proof: the anchored distribution copy, or, for an
-- anchor-only version, its verification certificate.
ALTER TABLE "ReportVersion" ADD CONSTRAINT "ReportVersion_complete_has_proof"
  CHECK ("status"::text <> 'COMPLETE' OR ("completedAt" IS NOT NULL AND (
    (NOT "anchorOnly" AND "copyRecordId" IS NOT NULL AND "copyStoredFileId" IS NOT NULL AND "copyBlock" IS NOT NULL)
    OR ("anchorOnly" AND "certificateStoredFileId" IS NOT NULL))));
