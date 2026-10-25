-- CreateTable
CREATE TABLE "LookupCount" (
    "orgId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "count" INTEGER NOT NULL,

    CONSTRAINT "LookupCount_pkey" PRIMARY KEY ("orgId","day")
);

-- AddForeignKey
ALTER TABLE "LookupCount" ADD CONSTRAINT "LookupCount_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "IssuerOrg"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A row exists only once a lookup has been counted.
ALTER TABLE "LookupCount" ADD CONSTRAINT "LookupCount_count_positive" CHECK ("count" > 0);
