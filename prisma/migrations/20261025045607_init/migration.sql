-- CreateEnum
CREATE TYPE "Role" AS ENUM ('PREPARER', 'APPROVER');

-- CreateEnum
CREATE TYPE "ReportType" AS ENUM ('STANDALONE', 'CONSOLIDATED');

-- CreateEnum
CREATE TYPE "OpinionType" AS ENUM ('UNMODIFIED', 'QUALIFIED', 'ADVERSE', 'DISCLAIMER');

-- CreateEnum
CREATE TYPE "VersionStatus" AS ENUM ('DRAFT', 'CONFIRMED');

-- CreateEnum
CREATE TYPE "ReasonCode" AS ENUM ('INITIAL', 'CORRECTION', 'SUBSEQUENT_EVENT', 'OTHER');

-- CreateTable
CREATE TABLE "IssuerOrg" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IssuerOrg_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Client" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "registrationNumber" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Engagement" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "engagementRef" TEXT NOT NULL,
    "periodEnd" DATE NOT NULL,
    "reportType" "ReportType" NOT NULL,
    "familyId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Engagement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReportVersion" (
    "id" TEXT NOT NULL,
    "engagementId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "reasonCode" "ReasonCode" NOT NULL,
    "status" "VersionStatus" NOT NULL DEFAULT 'DRAFT',
    "docHash" TEXT NOT NULL,
    "pageCount" INTEGER NOT NULL,
    "anchorOnly" BOOLEAN NOT NULL,
    "flags" JSONB NOT NULL,
    "storedFileId" TEXT NOT NULL,
    "extraction" BYTEA NOT NULL,
    "opinionType" "OpinionType",
    "confirmedOpinion" BYTEA,
    "reportDate" DATE,
    "opinionSalt" BYTEA,
    "opinionCommitment" TEXT,
    "manifestSalt" BYTEA,
    "manifest" BYTEA,
    "manifestHash" TEXT,
    "preparedById" TEXT NOT NULL,
    "confirmedById" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReportVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoredFile" (
    "id" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "iv" BYTEA NOT NULL,
    "authTag" BYTEA NOT NULL,
    "keyVersion" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StoredFile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_orgId_idx" ON "User"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "Client_orgId_country_registrationNumber_key" ON "Client"("orgId", "country", "registrationNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Engagement_familyId_key" ON "Engagement"("familyId");

-- CreateIndex
CREATE UNIQUE INDEX "Engagement_clientId_engagementRef_periodEnd_reportType_key" ON "Engagement"("clientId", "engagementRef", "periodEnd", "reportType");

-- CreateIndex
CREATE UNIQUE INDEX "ReportVersion_docHash_key" ON "ReportVersion"("docHash");

-- CreateIndex
CREATE UNIQUE INDEX "ReportVersion_storedFileId_key" ON "ReportVersion"("storedFileId");

-- CreateIndex
CREATE UNIQUE INDEX "ReportVersion_opinionSalt_key" ON "ReportVersion"("opinionSalt");

-- CreateIndex
CREATE UNIQUE INDEX "ReportVersion_manifestSalt_key" ON "ReportVersion"("manifestSalt");

-- CreateIndex
CREATE UNIQUE INDEX "ReportVersion_manifestHash_key" ON "ReportVersion"("manifestHash");

-- CreateIndex
CREATE INDEX "ReportVersion_preparedById_idx" ON "ReportVersion"("preparedById");

-- CreateIndex
CREATE INDEX "ReportVersion_confirmedById_idx" ON "ReportVersion"("confirmedById");

-- CreateIndex
CREATE UNIQUE INDEX "ReportVersion_engagementId_version_key" ON "ReportVersion"("engagementId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "StoredFile_path_key" ON "StoredFile"("path");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "IssuerOrg"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Client" ADD CONSTRAINT "Client_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "IssuerOrg"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Engagement" ADD CONSTRAINT "Engagement_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Engagement" ADD CONSTRAINT "Engagement_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportVersion" ADD CONSTRAINT "ReportVersion_engagementId_fkey" FOREIGN KEY ("engagementId") REFERENCES "Engagement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportVersion" ADD CONSTRAINT "ReportVersion_storedFileId_fkey" FOREIGN KEY ("storedFileId") REFERENCES "StoredFile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportVersion" ADD CONSTRAINT "ReportVersion_preparedById_fkey" FOREIGN KEY ("preparedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportVersion" ADD CONSTRAINT "ReportVersion_confirmedById_fkey" FOREIGN KEY ("confirmedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
