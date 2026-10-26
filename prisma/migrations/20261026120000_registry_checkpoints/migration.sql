-- #122: a month's checkpoint of the registry the firm anchors on, its root timestamped on Bitcoin
-- through OpenTimestamps, as #66 timestamps each manifest hash.

-- A proof is now of a version's manifest hash or of a checkpoint's head.
ALTER TABLE "OtsProof" ADD COLUMN     "checkpointId" TEXT,
ALTER COLUMN "reportVersionId" DROP NOT NULL;

CREATE TABLE "RegistryCheckpoint" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "registry" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "block" INTEGER NOT NULL,
    "root" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "file" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RegistryCheckpoint_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RegistryCheckpoint_orgId_chainId_registry_period_key" ON "RegistryCheckpoint"("orgId", "chainId", "registry", "period");
CREATE UNIQUE INDEX "OtsProof_checkpointId_key" ON "OtsProof"("checkpointId");

ALTER TABLE "OtsProof" ADD CONSTRAINT "OtsProof_checkpointId_fkey" FOREIGN KEY ("checkpointId") REFERENCES "RegistryCheckpoint"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RegistryCheckpoint" ADD CONSTRAINT "RegistryCheckpoint_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "IssuerOrg"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Each proof is of exactly one thing.
ALTER TABLE "OtsProof" ADD CONSTRAINT "OtsProof_one_subject" CHECK (num_nonnulls("reportVersionId", "checkpointId") = 1);

-- Shapes: a lower-case root and registry, a month, a block and at least one record (zero is never a checkpoint).
ALTER TABLE "RegistryCheckpoint" ADD CONSTRAINT "RegistryCheckpoint_shape" CHECK (
  "root" ~ '^0x[0-9a-f]{64}$'
  AND "registry" ~ '^0x[0-9a-f]{40}$'
  AND "period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
  AND "block" > 0
  AND "count" > 0
);

-- A checkpoint is written once: what was published is never changed.
CREATE FUNCTION registry_checkpoint_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'RegistryCheckpoint is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "RegistryCheckpoint_append_only"
  BEFORE UPDATE OR DELETE ON "RegistryCheckpoint"
  FOR EACH ROW EXECUTE FUNCTION registry_checkpoint_append_only();
