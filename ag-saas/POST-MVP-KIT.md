# Post-MVP Build Kit (Phase 2 / 3) — Certification-led

Ready-to-run prompts for the deferred work, to paste into the agri-saas session **after**
the MVP kit (`BUILD-KIT.md`) is done. Roadmap rationale: `PHASE-2-3-PLAN.md`.

**Sequence:** Certification (reseat → schemes) → Crop planning → Agronomic intelligence →
Enterprise & grain depth → Fast-follows.

**How to use:** if continuing the same session, run #7 → #12 in order. If starting fresh,
paste `MEMORY-IMPORT.md` first (it also reads `PHASE-2-3-PLAN.md`). Paste `MEMORY-EXPORT.md`
at each checkpoint. Legend: ⚖️ concept-only (reimplement) · ✅ portable (attribute).

---

### #7 — Certification module: reseat the gated compliance domain

```
Continuing the agri-saas session. Goal: turn the module-gated IC compliance domain back
ON as "Certification" for agriculture — minimal new schema, mostly reseating + vocabulary.

Build:
- Flip the CERTIFICATION ModuleKey on for tenants that want it (default still OFF). Un-gate
  the compliance route groups behind the CERTIFICATION module (nav/page/API) under
  agriculture vocabulary: Framework→"Scheme", FrameworkRequirement→"Scheme requirement",
  Control→"Practice/Control", Evidence→"Record", Audit→"Inspection", Finding→"Nonconformity".
  Vocabulary via messages/en.json only — DO NOT rename Prisma models.
- Add a CertificationScheme concept as a thin layer over Framework (kind=AG_SCHEME) so ag
  schemes coexist with any ISO frameworks. Reuse Framework/FrameworkRequirement as-is.
- Wire the Certification nav into the ag dashboard; readiness scoring per scheme reused.

Borrow: LiteFarm organic-cert export ⚖️ (feature spec). IC reuse: entire compliance engine
(Framework/Control/Evidence/Audit/Finding), readiness scoring, scripts/framework-import.ts.
Done: a tenant with CERTIFICATION on sees Schemes/Records/Inspections in ag vocabulary and
can create a scheme + requirements + link a Control; tsc 0; guardrails green. Commit to
feat/certification-reseat, push, MEMORY EXPORT.
```

### #8 — Certification: scheme catalogs + ag-record auto-evidence + inspection pack

```
Goal: make certification real with seeded schemes and farm data flowing in as evidence.

Build:
- Seed scheme requirement catalogs via scripts/import-schemes.ts (Framework imports):
  GlobalG.A.P. IFA + EU Organic (Reg. 2018/848) clause lists as versioned data.
- Auto-evidence: let journal LogEntries (esp. INPUT_APPLICATION spray records), inventory
  lots, and the spray traceability chain attach as Evidence to scheme requirements (reuse
  the Evidence submit/review/approve pipeline + EvidenceReview). A spray record satisfies
  the relevant GlobalG.A.P. plant-protection requirements automatically.
- Inspection prep: assemble an AuditPack from a scheme's requirements + linked records and
  share it with an external certifier via the existing AuditPackShare flow. "Applicability
  statement" CSV/PDF export reusing the reports machinery.

Borrow: LiteFarm cert export ⚖️; frappe/wiki ✅ for guidance links. IC reuse: Evidence +
EvidenceReview, AuditPack/AuditPackItem/AuditPackShare, reports/CSV/PDF, framework-import.
Done: seed loads GlobalG.A.P.+organic; a spray record auto-links as evidence; build + share
an inspection pack; export the applicability statement; tests; tsc 0. Commit to
feat/certification-schemes, push, MEMORY EXPORT.
```

### #9 — Crop planning (Season / CropPlan / Planting + succession engine)

```
Goal: succession planning that auto-generates field work and seed demand.

Build (lift from ag-saas/prisma-draft/planning.prisma): Season, CropPlan, Planting +
CropType/CropVariety catalogs. RLS trio + back-relations. A PURE, unit-tested succession
engine (src/lib/planning/) reimplementing Qrop/CropPlanning math: sow/transplant/harvest
dates from merged crop+variety defaults, seed-quantity, bed/area allocation. Auto-generate
field Tasks (reuse createTask) from plantings; plan-vs-actual derived from linked LogEntry
(LogPlanting). Planting board UI; seed varieties from OpenFarm CC0.

Borrow: Qrop/CropPlanning succession math ⚖️ (reimplement, GPL — no code); Permastead
schema ✅; OpenFarm CC0 variety defaults ✅; LiteFarm management-plan UX ⚖️.
Done: create a season + crop plan with successions; tasks auto-generate; seed-qty computed;
plan-vs-actual view; engine unit tests pass; tsc 0; rls-coverage green. Commit to
feat/crop-planning, push, MEMORY EXPORT.
```

### #10 — Agronomic intelligence (weather + GDD + risk; NDVI)

```
Goal: a data-driven layer enhancing spray, planning, and the risk register.

Build: a BullMQ job (src/app-layer/jobs) pulling Open-Meteo per Location → daily weather
obs store; GDD accumulation per planting; spray-window + disease-risk rules → notifications
+ entries in IC's Risk register (repurposed as agronomic/operational risk, reuse Risk +
matrix + treatment plans). NDVI/satellite AOI viewer on the map (geo.ts for tiles/AOI).
Sensor/data-stream ingestion endpoint (farmOS data-stream concept) behind a feature flag.

Borrow: Nekazari architecture ⚖️ + its Apache-2.0 SDK ✅; farmOS data-stream concept ⚖️;
Open-Meteo (free). IC reuse: BullMQ + executor registry, notifications, Risk/matrix/treatment.
Done: weather job populates obs; GDD shows on plantings; a spray-window warning fires as a
notification + risk; NDVI layer renders; tests; tsc 0. Commit to feat/agro-intel, push,
MEMORY EXPORT.
```

### #11 — Enterprise & grain depth (portfolio, grain storage, costing)

```
Goal: the large grain-producer persona + ENTERPRISE-tier value.

Build: Organization portfolio dashboards across child farms (reuse the hub-and-spoke +
OrgAuditLog + org dashboard widgets). Grain storage: bins as Locations with capacity;
moisture/test-weight/protein on InventoryLot.attributesJson; blending via LotLink genealogy.
Per-activity cost accounting: roll up LogEntry.costAmount + StockTransaction cost per
planting/field/season. Add yields/contracts to the field-encryption manifest; expose the
public API (OpenAPI) for enterprise integrations.

Borrow: Ekylibre cost-accounting concept ⚖️; OFBiz lot genealogy ✅. IC reuse: Organization
layer (built), dashboards, field encryption, audit-stream, SAML/SSO, OpenAPI generation.
Done: portfolio dashboard aggregates farms; grain bins track quality + blending lineage;
cost rollup per field/season; encrypted yield/contract fields; tests; tsc 0. Commit to
feat/enterprise-grain, push, MEMORY EXPORT.
```

### #12 — Fast-follows (in-map editing, offline PWA, reference data)

```
Goal: the smaller deferred items; pick any subset per priority.

Build:
- In-map drawing/editing: extend the Feature-1 MapCanvas with a GeometryEditor (terra-draw,
  MIT) — edit parcel polygons, draw new ones, split/merge; persist via geo.ts.
- Offline operator PWA: service worker + outbox queue on the SWR/optimistic-mutation hooks
  so operators execute spray jobs with no signal, syncing on reconnect (farmOS Field Kit ref).
- Reference-data expansion: full crop-variety catalog (OpenFarm CC0), product/active-
  ingredient DB, remaining scheme catalogs.

Borrow: terra-draw ✅; OpenFarm CC0 ✅; farmOS Field Kit ⚖️. IC reuse: SWR hooks, geo.ts,
seed-pipeline pattern.
Done: parcels editable on the map; an operator completes a job offline and it syncs; catalogs
expanded; tests; tsc 0. Commit to feat/fast-follows, push, FINAL MEMORY EXPORT.
```
