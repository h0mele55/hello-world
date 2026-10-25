-- Delayed revocation (#95): a revocation's request is on chain and waits out
-- the registry's delay (SCHEDULED) until it takes effect (REVOKED), unless the
-- registry's owner cancels it first (CANCELLED).
-- The new values are used by the next migration: Postgres refuses a new enum
-- value in the transaction that added it.

-- AlterEnum
ALTER TYPE "RevocationStatus" ADD VALUE 'SCHEDULED' BEFORE 'REVOKED';

-- AlterEnum
ALTER TYPE "RevocationStatus" ADD VALUE 'CANCELLED';

-- AlterTable
ALTER TABLE "Revocation" ADD COLUMN     "effectiveAt" TIMESTAMP(3);

-- Before the delay, a revocation took effect when its block was final.
UPDATE "Revocation" SET "effectiveAt" = "revokedAt" WHERE "status" = 'REVOKED' AND "effectiveAt" IS NULL;
