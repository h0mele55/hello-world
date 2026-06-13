-- ═══════════════════════════════════════════════════════════════════
--  Agriculture — Feature 1: spray-prescription map module
-- ═══════════════════════════════════════════════════════════════════
--  Adds the spatial domain (Location, Parcel), the input-product
--  catalog (Item) + global Unit table, and the per-parcel prescription
--  line (OperationParcel). The spray "job" itself reuses the existing
--  Task model (WorkItemType += FIELD_OPERATION).
--
--  This migration is intentionally self-contained: it was scaffolded
--  with `migrate dev --create-only`, then hand-edited to (1) prepend
--  the PostGIS extension required by Parcel.geometry, (2) drop unrelated
--  pre-existing schema/migration drift the scaffolder bundled in, and
--  (3) append the canonical RLS trio for the new tenant-scoped tables
--  (matching 20260422180000_enable_rls_coverage). Unit has NO tenantId
--  (global catalog) and therefore no RLS, by design.
-- ═══════════════════════════════════════════════════════════════════

-- ─── PostGIS (required before any geometry column) ───
CREATE EXTENSION IF NOT EXISTS postgis;

-- CreateEnum
CREATE TYPE "LocationStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ItemCategory" AS ENUM ('SEED', 'PESTICIDE', 'FERTILIZER', 'AMENDMENT', 'FUEL', 'HARVESTED_PRODUCE', 'OTHER');

-- CreateEnum
CREATE TYPE "QuantityMeasure" AS ENUM ('COUNT', 'WEIGHT', 'VOLUME', 'AREA', 'LENGTH', 'RATE', 'OTHER');

-- CreateEnum
CREATE TYPE "FieldOperationType" AS ENUM ('SPRAY', 'FERTILIZE', 'SEED', 'OTHER');

-- CreateEnum
CREATE TYPE "ParcelOperationStatus" AS ENUM ('PENDING', 'DONE', 'SKIPPED');

-- AlterEnum
ALTER TYPE "TaskLinkEntityType" ADD VALUE 'LOCATION';
ALTER TYPE "TaskLinkEntityType" ADD VALUE 'PARCEL';

-- AlterEnum
ALTER TYPE "WorkItemType" ADD VALUE 'FIELD_OPERATION';

-- CreateTable
CREATE TABLE "Unit" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "measure" "QuantityMeasure" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Unit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Item" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" "ItemCategory" NOT NULL,
    "sku" TEXT,
    "defaultUnitId" TEXT NOT NULL,
    "attributesJson" JSONB,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletedByUserId" TEXT,
    "retentionUntil" TIMESTAMP(3),

    CONSTRAINT "Item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Location" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "key" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "LocationStatus" NOT NULL DEFAULT 'ACTIVE',
    "ownerUserId" TEXT,
    "spatialFileId" TEXT,
    "spatialFormat" TEXT,
    "boundsJson" JSONB,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletedByUserId" TEXT,
    "retentionUntil" TIMESTAMP(3),

    CONSTRAINT "Location_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Parcel" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "key" TEXT,
    "name" TEXT NOT NULL,
    "cropType" TEXT,
    "geometry" geometry(MultiPolygon, 4326),
    "areaHa" DECIMAL(12,4),
    "propertiesJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletedByUserId" TEXT,
    "retentionUntil" TIMESTAMP(3),

    CONSTRAINT "Parcel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperationParcel" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "parcelId" TEXT NOT NULL,
    "productItemId" TEXT NOT NULL,
    "doseValue" DECIMAL(14,4) NOT NULL,
    "doseUnitId" TEXT NOT NULL,
    "targetNote" TEXT,
    "status" "ParcelOperationStatus" NOT NULL DEFAULT 'PENDING',
    "completedAt" TIMESTAMP(3),
    "completedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OperationParcel_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Unit_key_key" ON "Unit"("key");

-- CreateIndex
CREATE INDEX "Item_tenantId_category_idx" ON "Item"("tenantId", "category");

-- CreateIndex
CREATE INDEX "Item_tenantId_name_idx" ON "Item"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Item_id_tenantId_key" ON "Item"("id", "tenantId");

-- CreateIndex
CREATE INDEX "Location_tenantId_name_idx" ON "Location"("tenantId", "name");

-- CreateIndex
CREATE INDEX "Location_tenantId_status_idx" ON "Location"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Location_id_tenantId_key" ON "Location"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "Location_tenantId_key_key" ON "Location"("tenantId", "key");

-- CreateIndex
CREATE INDEX "Parcel_tenantId_locationId_idx" ON "Parcel"("tenantId", "locationId");

-- CreateIndex
CREATE UNIQUE INDEX "Parcel_id_tenantId_key" ON "Parcel"("id", "tenantId");

-- CreateIndex (spatial GiST index for fast geometry queries)
CREATE INDEX "Parcel_geometry_gist" ON "Parcel" USING GIST ("geometry");

-- CreateIndex
CREATE INDEX "OperationParcel_tenantId_taskId_idx" ON "OperationParcel"("tenantId", "taskId");

-- CreateIndex
CREATE INDEX "OperationParcel_tenantId_parcelId_idx" ON "OperationParcel"("tenantId", "parcelId");

-- CreateIndex
CREATE INDEX "OperationParcel_tenantId_status_idx" ON "OperationParcel"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "OperationParcel_taskId_parcelId_key" ON "OperationParcel"("taskId", "parcelId");

-- AddForeignKey
ALTER TABLE "Item" ADD CONSTRAINT "Item_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Item" ADD CONSTRAINT "Item_defaultUnitId_fkey" FOREIGN KEY ("defaultUnitId") REFERENCES "Unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Item" ADD CONSTRAINT "Item_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Location" ADD CONSTRAINT "Location_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Location" ADD CONSTRAINT "Location_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Location" ADD CONSTRAINT "Location_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Location" ADD CONSTRAINT "Location_spatialFileId_fkey" FOREIGN KEY ("spatialFileId") REFERENCES "FileRecord"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Parcel" ADD CONSTRAINT "Parcel_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Parcel" ADD CONSTRAINT "Parcel_locationId_tenantId_fkey" FOREIGN KEY ("locationId", "tenantId") REFERENCES "Location"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperationParcel" ADD CONSTRAINT "OperationParcel_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperationParcel" ADD CONSTRAINT "OperationParcel_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperationParcel" ADD CONSTRAINT "OperationParcel_parcelId_tenantId_fkey" FOREIGN KEY ("parcelId", "tenantId") REFERENCES "Parcel"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperationParcel" ADD CONSTRAINT "OperationParcel_productItemId_tenantId_fkey" FOREIGN KEY ("productItemId", "tenantId") REFERENCES "Item"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperationParcel" ADD CONSTRAINT "OperationParcel_doseUnitId_fkey" FOREIGN KEY ("doseUnitId") REFERENCES "Unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperationParcel" ADD CONSTRAINT "OperationParcel_completedByUserId_fkey" FOREIGN KEY ("completedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════
--  Row-Level Security — canonical trio for new tenant-scoped tables
--  (mirrors 20260422180000_enable_rls_coverage). Session var:
--  app.tenant_id. runInTenantContext drops to role app_user, against
--  which tenant_isolation bites; superuser_bypass permits every other
--  role (migrations / seeds / privileged paths). Unit is global → none.
-- ═══════════════════════════════════════════════════════════════════

-- ── Item ───────────────────────────────────────────────────────────
ALTER TABLE "Item" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Item" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "Item";
CREATE POLICY tenant_isolation ON "Item"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "Item";
CREATE POLICY tenant_isolation_insert ON "Item"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "Item";
CREATE POLICY superuser_bypass ON "Item"
    USING (current_setting('role') != 'app_user');

-- ── Location ───────────────────────────────────────────────────────
ALTER TABLE "Location" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Location" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "Location";
CREATE POLICY tenant_isolation ON "Location"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "Location";
CREATE POLICY tenant_isolation_insert ON "Location"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "Location";
CREATE POLICY superuser_bypass ON "Location"
    USING (current_setting('role') != 'app_user');

-- ── Parcel ─────────────────────────────────────────────────────────
ALTER TABLE "Parcel" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Parcel" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "Parcel";
CREATE POLICY tenant_isolation ON "Parcel"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "Parcel";
CREATE POLICY tenant_isolation_insert ON "Parcel"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "Parcel";
CREATE POLICY superuser_bypass ON "Parcel"
    USING (current_setting('role') != 'app_user');

-- ── OperationParcel ────────────────────────────────────────────────
ALTER TABLE "OperationParcel" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OperationParcel" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "OperationParcel";
CREATE POLICY tenant_isolation ON "OperationParcel"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "OperationParcel";
CREATE POLICY tenant_isolation_insert ON "OperationParcel"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "OperationParcel";
CREATE POLICY superuser_bypass ON "OperationParcel"
    USING (current_setting('role') != 'app_user');
