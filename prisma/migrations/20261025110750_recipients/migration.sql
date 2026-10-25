-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "Recipient" (
    "id" TEXT NOT NULL,
    "engagementId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "addedById" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMP(3),
    "removedById" TEXT,

    CONSTRAINT "Recipient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "reportVersionId" TEXT NOT NULL,
    "status" "NotificationStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Recipient_engagementId_idx" ON "Recipient"("engagementId");

-- CreateIndex
CREATE INDEX "Recipient_addedById_idx" ON "Recipient"("addedById");

-- CreateIndex
CREATE INDEX "Recipient_removedById_idx" ON "Recipient"("removedById");

-- CreateIndex
CREATE INDEX "Notification_reportVersionId_idx" ON "Notification"("reportVersionId");

-- CreateIndex
CREATE INDEX "Notification_status_leaseUntil_idx" ON "Notification"("status", "leaseUntil");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_recipientId_reportVersionId_key" ON "Notification"("recipientId", "reportVersionId");

-- AddForeignKey
ALTER TABLE "Recipient" ADD CONSTRAINT "Recipient_engagementId_fkey" FOREIGN KEY ("engagementId") REFERENCES "Engagement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Recipient" ADD CONSTRAINT "Recipient_addedById_fkey" FOREIGN KEY ("addedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Recipient" ADD CONSTRAINT "Recipient_removedById_fkey" FOREIGN KEY ("removedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "Recipient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_reportVersionId_fkey" FOREIGN KEY ("reportVersionId") REFERENCES "ReportVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- One live recipient per address and engagement; a removed one may be added again.
CREATE UNIQUE INDEX "Recipient_one_live_per_email" ON "Recipient"("engagementId", "email") WHERE "removedAt" IS NULL;
ALTER TABLE "Recipient" ADD CONSTRAINT "Recipient_email_lower" CHECK ("email" = lower("email"));
ALTER TABLE "Recipient" ADD CONSTRAINT "Recipient_locale" CHECK ("locale" IN ('en', 'bg'));
ALTER TABLE "Recipient" ADD CONSTRAINT "Recipient_removed_by" CHECK (("removedAt" IS NULL) = ("removedById" IS NULL));
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_sent_has_time" CHECK ("status"::text <> 'SENT' OR "sentAt" IS NOT NULL);
