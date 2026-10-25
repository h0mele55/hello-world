-- The registry watch (#93): how far it has read the chain, and the writes it
-- found by the firm's issuer keys that no journal row accounts for.

-- CreateEnum
CREATE TYPE "UnjournaledKind" AS ENUM ('ANCHOR', 'ANCHOR_COPY', 'REVOCATION');

-- CreateTable
CREATE TABLE "RegistryWatch" (
    "orgId" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "registry" TEXT NOT NULL,
    "lastBlock" BIGINT NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RegistryWatch_pkey" PRIMARY KEY ("orgId","chainId","registry")
);

-- CreateTable
CREATE TABLE "UnjournaledWrite" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "registry" TEXT NOT NULL,
    "kind" "UnjournaledKind" NOT NULL,
    "recordId" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "blockNumber" BIGINT NOT NULL,
    "issuer" TEXT NOT NULL,
    "effectiveAt" TIMESTAMP(3),
    "foundAt" TIMESTAMP(3) NOT NULL,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),

    CONSTRAINT "UnjournaledWrite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UnjournaledWrite_orgId_reviewedAt_idx" ON "UnjournaledWrite"("orgId", "reviewedAt");

-- CreateIndex
CREATE INDEX "UnjournaledWrite_reviewedById_idx" ON "UnjournaledWrite"("reviewedById");

-- CreateIndex
CREATE UNIQUE INDEX "UnjournaledWrite_chainId_registry_txHash_recordId_kind_key" ON "UnjournaledWrite"("chainId", "registry", "txHash", "recordId", "kind");

-- AddForeignKey
ALTER TABLE "RegistryWatch" ADD CONSTRAINT "RegistryWatch_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "IssuerOrg"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UnjournaledWrite" ADD CONSTRAINT "UnjournaledWrite_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "IssuerOrg"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UnjournaledWrite" ADD CONSTRAINT "UnjournaledWrite_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- A reviewer always comes with the time of the review; a revocation says when it takes effect.
ALTER TABLE "UnjournaledWrite" ADD CONSTRAINT "UnjournaledWrite_reviewed_has_time"
  CHECK ("reviewedById" IS NULL OR "reviewedAt" IS NOT NULL);
ALTER TABLE "UnjournaledWrite" ADD CONSTRAINT "UnjournaledWrite_revocation_has_time"
  CHECK ("kind"::text <> 'REVOCATION' OR "effectiveAt" IS NOT NULL);
