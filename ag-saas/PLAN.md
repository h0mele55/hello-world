# Agriculture SaaS — Master Plan (context for any session)

Build an enterprise agriculture-management SaaS **on top of the inflect-compliance
(IC) platform** — usable equally by startup farmers and large grain producers.
This doc is the durable memory of the planning done in the originating session.
Companion docs: `REPOS.md` (open-source analysis + borrow matrix),
`prisma-draft/` (broader Phase 0/1 schema), `feature-1-spray-map/` (first feature).

## Strategy: keep / repurpose / build

IC is ~70% of an enterprise SaaS already (Next 16 / React 19 / Prisma 7 / Postgres
RLS multi-tenancy, hash-chained audit log, BullMQ jobs, Stripe entitlements, S3 +
ClamAV storage, approval workflows, field encryption, SAML/OIDC SSO, OTel, i18n,
10k+ tests + guardrails, Terraform/Compose/Helm). So we do **not** fork any farm
repo — we keep IC as the chassis and add agriculture domain layers.

- **Keep as-is:** multi-tenancy (Tenant + RLS + RequestContext), auth/RBAC + custom
  roles, Organization hub-and-spoke, audit log + stream, notifications, storage +
  ClamAV + retention, BullMQ, Stripe billing/entitlements, rate limiting, OTel/Sentry,
  next-intl, the UI system (Radix/Tailwind + ListPageShell/EntityDetailLayout, Visx,
  react-grid-layout, TipTap, @xyflow), SWR data-fetching, Zod/DTO conventions, CI +
  guardrail culture, infra.
- **Repurpose (rename, don't rewrite):** the compliance engine itself — agriculture
  is compliance-heavy (GlobalG.A.P., EU organic, Red Tractor, CAP, spray records).
  Framework→Requirement→Control→Evidence→Audit→Finding→CAPA maps ~1:1 onto farm
  certification. This becomes the enterprise differentiator no farm OSS has.
- **Build new (3 modules + 1 capability):** farm journal (farmOS Log/Asset/Quantity
  ontology), inventory (InvenTree schema), crop planning (Qrop/CropPlanning math),
  and **geospatial** (PostGIS + MapLibre) — the one new infra dependency.

## Domain mapping (compliance → agriculture)

| IC today | becomes / powers |
|---|---|
| Tenant | Farm operation |
| Organization (hub-and-spoke) | Enterprise group / co-op / agronomy consultancy over many farms |
| Asset (C/I/A) | Location (field/bin, +PostGIS), Equipment, PlantingBatch |
| *(new)* | LogEntry + Quantity (the journal) |
| *(new)* | Item / InventoryLot / StockTransaction (append-only ledger = traceability) |
| *(new)* | CropType / Variety / CropPlan / Planting |
| Task + TaskLink + comments + watchers | Farm tasks / field operations |
| Framework / Requirement | CertificationScheme / Requirement (GlobalG.A.P., EU organic…) |
| Control + ControlTestPlan/Run | Recurring practices, inspections, equipment maintenance |
| Evidence + Review | Farm records with QA sign-off (spray records, harvest QA) |
| Audit / AuditCycle / AuditPack (+external share) | Certification audit prep + external certifier share |
| Finding + corrective action | Scouting issues & nonconformities → CAPA |
| Policy / Version / Acknowledgement | SOPs + Knowledge base (read & sign) |
| Risk + matrix + treatment plan | Agronomic & operational risk register |
| Vendor + assessments + documents | Suppliers & buyers (elevators, contracts) |
| AuditLog hash chain | Food-safety traceability + enterprise audit trail |

## Phased roadmap

- **Phase 0 — Platform extraction:** fork IC; gate the compliance domain behind a
  module flag (don't delete — it returns as the Certification module); add PostGIS +
  map stack; reference-data seed pipeline; carry over guardrails/CI.
- **Phase 1 — MVP for small farms:** Locations on a map, Journal, ag Tasks, basic
  Inventory, weather feed, mobile PWA entry, onboarding. **Feature 1 (spray map) is
  the first slice of this.**
- **Phase 2 — Depth:** crop planning + successions; Knowledge base (OpenFarm CC0
  seed); harvest→inventory traceability ledger; Certification module v1 (re-skin
  Framework/Evidence/AuditPack for EU organic).
- **Phase 3 — Enterprise:** Organization portfolio dashboards; grain storage (bins,
  moisture, lot genealogy); equipment maintenance; per-activity costing; agronomic
  risk engine (GDD/disease from weather); sensor/satellite integrations.

## Serving both market ends (mostly already solved by IC)

- **Startup farmers** → FREE/PRO Stripe tiers via `assertWithinLimit`; "simple mode"
  via a tenant module-flag hiding planning/certification/risk so day one is just
  "map fields, log work, track stock."
- **Large grain producers** → ENTERPRISE: Organization portfolio, SAML/Entra SSO,
  custom roles, audit-stream webhooks to their SIEM, field encryption for
  yields/contracts, API access, grain-quality tracking, cost accounting, risk register.

## Feature 1 (spray-prescription map) — DEFERRED items and their future homes

Feature 1 deliberately scoped these OUT; here is where each lands so they aren't lost:

1. **Full inventory ledger + stock-deduction on spray completion** → **Phase 2
   (inventory module).** When an `OperationParcel` is marked DONE it will emit a
   `StockTransaction` (CONSUMPTION) against the product lot + a `LogEntry`
   (INPUT_APPLICATION) — turning the spray job into a compliant, inventory-accurate
   spray record. Schema for this is already drafted in `prisma-draft/inventory.prisma`
   and `prisma-draft/agriculture.prisma` (LogEntry/Quantity).
2. **In-map polygon drawing/editing** → **fast-follow to Feature 1.** `terra-draw`
   (MIT) is already in the planned dep set; Feature 1 ships import-first (covers the
   stated need), drawing/editing is the next UX iteration on `MapCanvas`.
3. **Module-gating flag (compliance vs ag modules; "simple mode")** → **Phase 0 WP-2.**
   Add `TenantModuleSettings` + `ModuleKey` enum (drafted in
   `prisma-draft/enums-additions.prisma` / `agriculture.prisma`), resolve in
   `src/lib/entitlements.ts`, enforce with a `requireModule()` page/API gate + a
   `module-gate-coverage` guardrail. Gates the parked compliance routes and powers
   startup-farmer simple mode.
4. **Offline operator PWA** → **Phase 3 / field-ops enhancement.** A phones-with-gloves
   route group (big targets, photo-first, queue-and-sync) for operators executing jobs
   in the field with no signal. Reference: farmOS Field Kit; build on IC's SWR +
   optimistic-mutation hooks + a service-worker outbox.

## License hygiene (enforce in CI)

The product stays proprietary. **Never copy code** from GPL/AGPL repos (farmOS,
LiteFarm, ERPNext/frappe-agriculture, Qrop, Ekylibre, Nekazari-core, Bigcapital,
Open Food Network) — concepts/schemas/algorithms reimplemented in our own code are
fine, literal code is not. **Free to port with attribution:** InvenTree, HortusFox,
Permastead, FarmBot, Tania, OFBiz, Nekazari-SDK (Apache-2.0), PermaplanT (BSD),
OpenFarm data (CC0), farmOS-map (MIT), shpjs (MIT), @tmcw/togeojson (BSD-2),
MapLibre (BSD-3), terra-draw (MIT). Add a `license-hygiene` guardrail that greps for
GPL/AGPL headers + known farmOS/LiteFarm/Ekylibre symbol names. See `REPOS.md`.
