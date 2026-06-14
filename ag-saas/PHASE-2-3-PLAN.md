# Post-MVP Roadmap — Phase 2 / 3 (deferred beyond the MVP)

Everything deferred past Phase 0 + MVP core (extraction, Journal, Inventory, Tasks,
Knowledge base) and past Feature 1 (spray map). Companion: `POST-MVP-KIT.md` (ready-to-run
build prompts). Source of truth for vision/mapping/licensing: `PLAN.md` + `REPOS.md`.

**Recommended sequence:** Certification → Crop planning → Agronomic intelligence →
Enterprise & grain depth, with the small fast-follows interleaved. Rationale: Certification
is the fastest high-value win (it reuses the compliance engine you already have); crop
planning completes the core farming loop and creates demand for intelligence; intelligence
enhances spray + planning + risk; enterprise/grain depth monetizes the large-producer
persona and benefits from accumulated data.

Legend: ⚖️ = concept/UX reference only (GPL/AGPL, reimplement) · ✅ = portable code/data
(MIT/Apache/BSD/CC0, attribute in THIRD_PARTY_NOTICES.md).

---

## E1 — Certification module (LEAD, Phase 2) · effort M

**What.** Re-enable the module-gated compliance domain as **Certification**: repurpose
IC's Framework → FrameworkRequirement → Control → Evidence → Audit/AuditCycle/AuditPack →
Finding into agricultural schemes (GlobalG.A.P. IFA, EU Organic 2018/848, Red Tractor,
custom buyer specs). Wire farm records (journal entries, spray records, inventory lots,
traceability) in as Evidence; produce the inspector AuditPack via the existing external-share
flow; nonconformities → CAPA via Finding.

**Why.** Highest enterprise differentiator at the lowest effort — almost no new schema; it's
reseating + seeding + linking ag data as evidence. No farm OSS has this.

**Borrow.** LiteFarm organic-cert export ⚖️ (feature spec only). frappe/wiki ✅ for
guidance cross-links. No GPL/AGPL code copied.

**IC reuse.** The whole compliance engine (already in the repo, gated by the MVP P1 module
flag): `Framework`/`Control`/`Evidence`/`Audit*`/`Finding` models, `scripts/framework-import.ts`
(scheme catalogs), the Evidence submit/review/approve pipeline, `AuditPackShare`
(certifier access), readiness scoring.

**Deps.** MVP (module-gating, journal, inventory). **Risk:** scheme-catalog accuracy →
treat requirement catalogs as versioned data, seed from official clause lists.

## E2 — Crop planning (Phase 2) · effort M–L

**What.** Season → CropPlan → Planting (drafted in `prisma-draft/planning.prisma`):
succession scheduling (sow/transplant/harvest dates from merged crop+variety defaults),
auto-generated field Tasks, seed-quantity + bed/area allocation, plan-vs-actual derived from
linked `LogEntry` (LogPlanting). Completes the farming loop and feeds seed-inventory demand.

**Why.** Rounds out the core workflow (esp. market gardeners); drives tasks + inventory.

**Borrow.** Qrop/CropPlanning succession math ⚖️ (reimplement, GPL); Permastead schema ✅;
OpenFarm CC0 variety defaults ✅; LiteFarm management-plan UX ⚖️.

**IC reuse.** `createTask` auto-generation, calendar, journal `LogPlanting` links, SWR
list/detail patterns. **Deps.** Journal + Tasks (MVP). **Risk:** the date/succession engine
is the real work — keep it a pure, unit-tested module like the spatial parser.

## E3 — Agronomic intelligence (Phase 3) · effort L

**What.** Weather ingestion (BullMQ job per Location, Open-Meteo) + daily-obs store; GDD
accumulation; spray-window & disease-risk warnings → notifications + IC Risk register;
NDVI/satellite viewer; sensor/data-stream ingestion (farmOS data-stream concept).

**Why.** Data-driven differentiation; enhances spray (Feature 1), planning (GDD), and risk.

**Borrow.** Nekazari architecture ⚖️ (+ its Apache-2.0 SDK ✅); farmOS data-stream concept
⚖️; Open-Meteo free API. **IC reuse.** BullMQ jobs, notifications, `Risk` + matrix +
treatment plans (repurpose as agronomic/operational risk), `geo.ts` for AOI/NDVI tiles.
**Deps.** Locations/Parcels (Feature 1), a weather job.

## E4 — Enterprise & grain depth (Phase 3) · effort M–L

**What.** Organization portfolio dashboards (multi-farm "agronomist/portfolio" view);
grain storage (bins as Locations with capacity; moisture/test-weight/protein on
`InventoryLot.attributesJson`; blending via `LotLink` genealogy); per-activity cost
accounting (`LogEntry.costAmount` + `StockTransaction` cost → rollups per planting/field/season).

**Why.** Serves the large grain-producer persona; anchors the ENTERPRISE tier.

**Borrow.** Ekylibre cost-accounting concept ⚖️; OFBiz lot genealogy ✅ (partly in inventory).
**IC reuse.** Organization hub-and-spoke + `OrgAuditLog` (built), org dashboard widgets
(react-grid-layout), field-encryption manifest (add yields/contracts), audit-stream webhooks,
SAML/SSO, OpenAPI. **Deps.** Inventory (MVP), Organization layer (built).

## Fast-follows (small, interleave anytime)

- **In-map drawing/editing** (terra-draw, MIT ✅) — extend Feature-1 `MapCanvas` with a
  `GeometryEditor`: edit parcel polygons, draw new ones, split/merge. Effort S. Best right
  after Certification since it builds directly on Feature 1.
- **Offline operator PWA** — service worker + outbox queue on the SWR/optimistic-mutation
  hooks so operators execute spray jobs with no signal (farmOS Field Kit ref ⚖️). Effort M.
- **Reference-data expansion** — full crop-variety catalog (OpenFarm CC0 ✅), scheme
  requirement catalogs (GlobalG.A.P./EU-organic), product/active-ingredient DB. Effort S–M;
  pull alongside the epic that needs it.
- **Vocabulary/model renames + full i18n** (bg + others) — the deferred Prisma model renames
  and message coverage. Effort M; do when the surface stabilizes.

## Cross-cutting (every epic)

RLS trio on new tenant tables; reuse IC patterns (Assets/Policy/Task/Framework modules);
`logEvent` on state changes; license hygiene per `REPOS.md`; guardrails green; run MEMORY
EXPORT at each checkpoint. Keep `PLAN.md` the source of truth — update it if scope shifts.
