-- CreateTable
CREATE TABLE "AuditChainCheck" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "count" INTEGER NOT NULL,
    "head" TEXT,
    "brokenSeq" INTEGER,
    "reason" TEXT,

    CONSTRAINT "AuditChainCheck_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AuditChainCheck_orgId_checkedAt_idx" ON "AuditChainCheck"("orgId", "checkedAt");

-- AddForeignKey
ALTER TABLE "AuditChainCheck" ADD CONSTRAINT "AuditChainCheck_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "IssuerOrg"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- An intact check names its head; a broken one names where and why.
ALTER TABLE "AuditChainCheck" ADD CONSTRAINT "AuditChainCheck_outcome"
  CHECK (("ok" AND "head" IS NOT NULL AND "brokenSeq" IS NULL AND "reason" IS NULL) OR (NOT "ok" AND "brokenSeq" IS NOT NULL AND "reason" IS NOT NULL));
