-- The worker reads two endpoints and records when they disagree (#92).

-- AlterTable
ALTER TABLE "IssuerKeyStatus" ADD COLUMN     "rpcDisagreedAt" TIMESTAMP(3);

