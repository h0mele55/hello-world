-- Whether the preparer corrected the located opinion at confirmation (#157). Rows confirmed before it
-- read false: their copies were stamped with version 1, which does not say.
ALTER TABLE "ReportVersion" ADD COLUMN "opinionEdited" BOOLEAN NOT NULL DEFAULT false;
