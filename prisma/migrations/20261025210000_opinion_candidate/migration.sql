-- #77: which of a PDF's several auditor's reports the confirmed opinion was taken from.
ALTER TABLE "ReportVersion" ADD COLUMN "opinionCandidate" INTEGER;
ALTER TABLE "ReportVersion" ADD CONSTRAINT "ReportVersion_opinion_candidate" CHECK ("opinionCandidate" IS NULL OR ("opinionCandidate" >= 0 AND "confirmedOpinion" IS NOT NULL));
