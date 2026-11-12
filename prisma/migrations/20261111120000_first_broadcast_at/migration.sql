-- When a write was first sent (#139): replacements move broadcastAt, so the
-- finality-lag alert reads this instead. Rows already sent take their last
-- broadcast as the best known first one.
ALTER TABLE "ChainWrite" ADD COLUMN "firstBroadcastAt" TIMESTAMP(3);

UPDATE "ChainWrite" SET "firstBroadcastAt" = "broadcastAt" WHERE "broadcastAt" IS NOT NULL;
