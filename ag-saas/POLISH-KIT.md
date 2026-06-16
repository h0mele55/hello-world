# Polish & Hardening Kit (#13–#18) — agri-saas → enterprise-grade

Continues the MVP (`BUILD-KIT.md`, #1–6) and Post-MVP (`POST-MVP-KIT.md`, #7–12) kits.
Grounded in a code inspection of the agri-saas repo (HEAD `174b451`, 37 commits, 1,378 test
files): prompts 1–12 are essentially delivered; the remaining gap is **enterprise hardening +
automation, not features**. These 6 close it.

**How to use:** run in the agri-saas session (re-paste `MEMORY-IMPORT.md` first if starting
fresh). Mostly independent; recommended order **13 → 14 → 17** (enterprise-blocking:
isolation, regression safety, correctness) **→ 15 → 16 → 18** (the "cherry"). Paste
`MEMORY-EXPORT.md` at each checkpoint.

---

### #13 — Security hardening & supply chain

```
Goal: drift-proof tenant isolation, abuse-resistant spatial uploads, supply-chain confidence
on the ag surfaces. Continuing the agri-saas session (memory imported).

Build:
- AG RLS isolation/fuzz tests: tests/integration/ag-rls-isolation.test.ts — two tenants,
  assert Location/Parcel/OperationParcel/InventoryLot/StockTransaction/YieldRecord/Contract
  isolation across CRUD + spray-completion + ledger-append paths (not just policy existence).
  Reuse tests/integration/rls-isolation.test.ts + TENANT_SCOPED_MODELS.
- Spatial-upload abuse hardening (importLocationSpatialFile): size caps (shapefile 5MB /
  GeoJSON 10MB), polygon-complexity limit (max vertices; reject self-intersecting pre-persist),
  move parsing to a BullMQ job with a 30s CPU budget. Reuse existing file-upload-limits + ClamAV.
- Supply chain: npm audit + lockfile audit in CI (block high/critical); SBOM (syft) on release;
  pin geo libs (shpjs/@tmcw/togeojson/maplibre-gl). Reuse the Trivy/CodeQL pipeline.
- (Stretch) SCIM 2.0 server (/api/scim/v2/Users,Groups), tenant-isolated, for multi-farm
  aggregators; reuse NextAuth SAML + permission middleware.

Done: cross-tenant fuzz tests fail closed; oversized/invalid shapefile rejected + parsed
off-thread; CI blocks vulnerable deps + emits SBOM; tsc 0; guardrails green. Commit
feat/harden-security, push, MEMORY EXPORT.
```

### #14 — Test depth & QA automation

```
Goal: regression-proof the tier-1 farmer workflows (regulatory + financial data).

Build:
- 8 Playwright E2E specs (tests/e2e/ag-*.spec.ts): location-import, spray-operation
  (job→mark lines→ledger deduction), inventory-traceability, harvest-yield, crop-plan,
  grain-contracts, agro-signals, offline-queue. Reuse tests/e2e/fixtures.ts + auth helpers.
- Seed-based ag fixtures: prisma/fixtures/ag-demo.ts (3 fields, 10 parcels, 5 products,
  2 spray jobs) referenced by all ag E2E + integration tests.
- Load tests (k6): tests/load/ag-inventory-pagination.js (10 operators × 10k-lot location,
  assert p95<500ms) + ag-parcel-list.js. Reuse tests/load/lists.js.
- Contract snapshots for ag APIs (Location, OperationParcel, InventoryLot, YieldRecord,
  Contract) in tests/contracts; assert backward-compat in CI. Reuse the OpenAPI generator.
- Visual-regression baseline on the parcel/spray map (Playwright snapshots).

Done: ag E2E suite green in CI; load p95 budgets asserted; contract snapshots committed;
ag-usecase coverage thresholds raised; tsc 0. Commit feat/qa-depth, push, MEMORY EXPORT.
```

### #15 — Performance & scale

```
Goal: keep large operations (50+ fields, 100k+ lots) fast.

Build:
- PostGIS/index audit: add composite indexes (Parcel(tenantId,locationId,deletedAt);
  InventoryLot(tenantId,cropPlanId,parentLotId)); confirm GiST on geometry; profile
  parcel-list (5k rows, 3 filters) to <200ms p95 with pgBench (document before/after).
- Geometry simplification + vector tiles: ST_Simplify on export; a PMTiles/vector-tile
  endpoint /api/t/:slug/locations/:id/tiles/{z}/{x}/{y}.pbf; map uses vector tiles at
  zoom≥6, GeoJSON for sketch mode. All ST_* stays in src/lib/db/geo.ts.
- Caching: Redis layer (src/lib/cache/) for CropType/CropVariety/Unit (1d) + WeatherObservation
  (6h); SWR config (revalidateOnFocus:false, dedupingInterval) on catalog hooks. Reuse the
  Redis the rate-limiter already uses.
- Ledger/list pagination + N+1: cursor-paginate lotLedger(); batch the LotLink parent-walk.

Done: documented benchmark deltas; no N+1 on traceability; tile endpoint serves; tsc 0.
Commit feat/perf-scale, push, MEMORY EXPORT.
```

### #16 — Observability & SRE

```
Goal: see and alert on field workflows.

Build:
- OTel spans on critical ag usecases: field-operation.markOperationParcel,
  createHarvestLogEntry, recordInputApplication, postYieldRecord, generateCropPlannings
  (with attributes: ids, doseValue, status). Reuse src/lib/observability/instrumentation.ts.
- AG audit event types (PARCEL_CREATED/GEOMETRY_UPDATED, SPRAY_JOB_STARTED,
  OPERATION_PARCEL_MARKED, HARVEST_YIELD_RECORDED, LEDGER_RECONCILIATION_RUN) wired into the
  usecases + audit stream; extend the audit-event-coverage guardrail.
- Grafana dashboard (docs/grafana/ag-operations.json) + Prometheus recording rules + SLO
  alerts (e.g., ag.field-operation p95<1s); ag runbooks (docs/runbooks/ag-parcel-import-
  failures.md, ag-ledger-reconciliation-drift.md, ag-weather-ingestion-lag.md).

Done: spans visible in traces; ag events in the audit log; dashboard + alerts defined;
runbooks present; guardrails green; tsc 0. Commit feat/observability, push, MEMORY EXPORT.
```

### #17 — Data integrity & correctness

```
Goal: guarantee geometry, ledger, and unit math are correct (regulatory + financial stakes).

Build:
- Geometry validity/repair: re-validate after terra-draw edit (client preview + server
  enforce); ST_MakeValid before upsert; backfill scripts/validate-parcel-geometries.ts to
  flag/repair existing parcels; ensure areaHa is never silently NULL. Use src/lib/db/geo.ts.
- Ledger reconciliation + idempotency: daily BullMQ job reconcile-inventory-ledgers (assert
  lot.quantityOnHand == SUM(transactions) + chain integrity, log drift); idempotency key
  (operationParcelId+logEntryId) so recordInputApplication retries can't double-deduct;
  integration test "spray→log→ledger→yield reconciles to zero".
- Unit-conversion correctness: src/lib/units/unit-conversion.ts (typed conversions) +
  dimensional-analysis guardrail (tests/guardrails/unit-conversion-dimensional-analysis.test.ts):
  L/ha × ha = L, kg→g exact; audit field-operation dose math.
- Migration-safety guardrail for ag ledger schema changes (reversibility + integrity).

Done: invalid geometries repaired/blocked; reconciliation + idempotency tests pass; unit
guardrail green; tsc 0. Commit feat/data-integrity, push, MEMORY EXPORT.
```

### #18 — UX/a11y/i18n polish + AI "cherry"

```
Goal: field-grade UX + the differentiating intelligence (reuse the existing Claude surface).

Build (polish):
- Responsive field-mobile: map + parcel list stack <768px; touch-friendly terra-draw controls;
  verify on Playwright mobile profiles.
- WCAG 2.1 AA: jest-axe on Location/OperationParcel/InventoryLot/CropPlan/YieldRecord pages;
  keyboard nav + ARIA on the map; non-color-only status encoding.
- bg i18n completeness: add missing ag-domain keys to messages/bg.json; add an en/bg parity
  guardrail to CI.
- Design consistency: standardize status pills/metadata via shared components.

Build (AI cherry — reuse src/app-layer/ai/risk-assessment/openrouter-provider.ts / Claude):
- Agronomy copilot: when an AgroSignal fires, generate a plain-language spray-window/disease
  explanation (stage, GDD, weather, pest, what-if) → store in AgroSignal.detailsJson + notify.
- Photo pest/disease ID: on image upload to a LogEntry, run Claude vision async → identified
  pest + recommendation into LogEntry.attributesJson + an in-page suggestion (show confidence
  + a "verify with an agronomist" disclaimer).
- (Stretch) weather-anomaly alerts (>2σ vs historical), yield prediction, rotation suggestion.

Done: ag pages pass axe + mobile E2E; bg parity guardrail green; copilot + photo-ID render
with confidence + human-review disclaimer; tsc 0. Commit feat/polish-ai, push, FINAL MEMORY EXPORT.
```
