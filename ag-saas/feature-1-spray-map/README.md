# Feature 1 — Spray-Prescription Map Module (validated foundation)

This folder is a **durable staging copy** of validated work for the first
agriculture feature, built on the inflect-compliance (IC) platform.

> **Why it's here and not in `agri-saas`:** `agri-saas`
> (https://github.com/h0mele55/agri-saas) was created, but this sandbox's
> git access is proxied to `hello-world` only — I cannot push a codebase to
> `agri-saas` or to the IC repo from here. Since inflect-compliance is public,
> saving this here leaks nothing. See "Getting this into agri-saas" below.

## The problem this solves

Today farmers tell machine operators what/how much to spray and where via paper
notebooks or verbal instructions. This feature replaces that with: farmer
uploads parcel-boundary files → parcels render on a map → farmer clicks parcels
and assigns a spray product + dose (a "job") → operators open the job and
execute it parcel by parcel.

## What is built AND validated (against a live PostGIS DB)

Validated in a real IC dev environment: PostgreSQL 16 + **PostGIS 3.4.2** (run
natively — the Docker registry was network-blocked, so PostGIS was installed via
apt and a local cluster used), all 131 existing IC migrations applied, then:

| Piece | File | Validation |
|---|---|---|
| Domain schema | `prisma/agriculture.prisma` | `prisma validate` ✓, `tsc --noEmit` ✓ |
| Migration (PostGIS + RLS) | `prisma/migration.sql` | **applied**; tables, `geometry(MultiPolygon,4326)`, GiST index, RLS trio + FORCE all verified |
| Geo SQL helper | `src/lib/db/geo.ts` | typechecks; contains all `ST_*` usage |
| Spatial parser | `src/lib/spatial/parse.ts` | **14 unit tests pass** |
| Parser tests | `tests/spatial-parse.test.ts` | shapefile/KML/GeoJSON, normalization, errors |
| Full feature diff | `feature1.patch` | `git format-patch` of the whole change |

**Data model:** `Location` (the uploaded field block) → `Parcel` (one PostGIS
MultiPolygon each) ; `Item` + `Unit` (structured input-product catalog with dose
units) ; `OperationParcel` (the per-parcel prescription line). The spray **job**
reuses the existing `Task` model (`WorkItemType += FIELD_OPERATION`), so
assignment, status, comments, watchers and notifications come for free. Every
new tenant table carries the canonical RLS trio (`tenant_isolation` +
`tenant_isolation_insert` + `superuser_bypass`, FORCE on); `Unit` is a global
catalog (no tenantId, no RLS) by design.

**Licensing:** spatial parsing uses only permissive libs — `shpjs` (MIT),
`@tmcw/togeojson` (BSD-2), `@xmldom/xmldom`, `@turf/bbox`. No GPL/AGPL farm-repo
code is copied. The map UI (next increment) uses MapLibre GL (BSD-3) +
`react-map-gl` + `terra-draw` (MIT).

## Edits to existing IC files (captured fully in `feature1.patch`)

- `prisma/schema/enums.prisma`: `WorkItemType += FIELD_OPERATION`;
  `TaskLinkEntityType += LOCATION, PARCEL`; new enums `LocationStatus`,
  `ItemCategory`, `QuantityMeasure`, `FieldOperationType`, `ParcelOperationStatus`.
- `prisma/schema/auth.prisma`: back-relations on `Tenant` (locations/parcels/
  items/operationParcels) and `User` (LocationOwner/LocationCreator/ItemCreator/
  OperationParcelCompleter).
- `prisma/schema/compliance.prisma`: `Task.operationParcels`,
  `FileRecord.locationSpatialFiles` back-relations.
- `docker-compose.yml`: Postgres image → `postgis/postgis:16-3.4`.
- `package.json`: adds `shpjs`, `@tmcw/togeojson`, `@xmldom/xmldom`, `@turf/bbox`.

## Getting this into `agri-saas`

`agri-saas` is empty (auto-init README only). To seed it the right way (one-time,
from your machine — you have push rights there and IC is public):

```bash
git clone https://github.com/inflect-compliance/inflect-compliance.git agri-saas-src
cd agri-saas-src
git remote add agri https://github.com/h0mele55/agri-saas.git
git push -u agri main --force   # seed agri-saas with the IC platform base
git checkout -b feat/spray-map-feature1
git am /path/to/feature1.patch  # apply this feature
git push -u agri feat/spray-map-feature1
```

Then open a Claude Code session scoped to `agri-saas` and I can continue building
with direct push access.

## Remaining increment (not yet built)

Backend (validatable against the live DB): the `spatial-import` usecase +
`Location`/`Parcel` repository (persist geometry via `geo.ts`, area via
`ST_Area`), the `field-operation` usecase (create the FIELD_OPERATION Task + the
OperationParcel lines), and the API routes under
`/api/t/[tenantSlug]/locations…`. Frontend: MapLibre `MapCanvas`,
`SpatialImportModal`, `PrescriptionPanel`, the locations pages, and the operator
execution view on the task detail page. Seed scripts for units + demo products.
