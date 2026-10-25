-- What a notice tells its recipient (#96): that a newer version supersedes
-- theirs, as before, or that a version of the report is revoked. Every
-- existing notice is a SUPERSEDED one.

-- CreateEnum
CREATE TYPE "NotificationKind" AS ENUM ('SUPERSEDED', 'REVOKED');

-- DropIndex
DROP INDEX "Notification_recipientId_reportVersionId_key";

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "kind" "NotificationKind" NOT NULL DEFAULT 'SUPERSEDED';

-- CreateIndex
CREATE UNIQUE INDEX "Notification_recipientId_reportVersionId_kind_key" ON "Notification"("recipientId", "reportVersionId", "kind");

