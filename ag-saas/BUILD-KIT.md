# Platform Build Kit — Transform inflect-compliance into the Agriculture SaaS MVP

How to turn the IC platform into a farmer-usable MVP, as a sequence of prompts you
paste into one continuous Claude Code session scoped to the `agri-saas` repo.

- **Scope of this kit:** Phase 0 + MVP core — extraction → Journal → Inventory →
  Tasks → Knowledge base. (Crop planning, certification, enterprise = Phase 2/3 in
  `PLAN.md`.)
- **Companion docs (same folder):** `PLAN.md` (roadmap, domain mapping, deferred
  items, license rules), `REPOS.md` (open-source borrow matrix + licensing),
  `feature-1-spray-map/` (the first, already-validated feature + dev-DB recipe),
  `prisma-draft/` (Phase 0/1 schema drafts).

## How to use

1. Open one agri-saas session. Paste **MEMORY-IMPORT.md** once; let it load context,
   verify repo + dev DB, and report status before building.
2. Run **BUILD PROMPT 1 → 6** below, in order, in that same session.
3. Paste **MEMORY-EXPORT.md** at the end of each prompt (or end of day) to persist
   status/decisions back to the repo, so a future fresh session can re-import.

The import/export prompts also live as standalone files for easy pasting:
`MEMORY-IMPORT.md` and `MEMORY-EXPORT.md`.

---

## ▶ BUILD PROMPT 1 — Phase 0: platform extraction & module system

```
Continuing in the same agri-saas session (memory already imported). Goal: make IC the
agriculture chassis without deleting the compliance domain — gate it behind a module flag
(it returns later as the Certification module).

Build:
- ModuleKey enum + TenantModuleSettings model (see ag-saas/prisma-draft/enums-additions
  .prisma & agriculture.prisma), shaped like TenantSecuritySettings in auth.prisma. RLS
  trio + back-relation on Tenant. Migration via create-only → add RLS → migrate deploy.
- Resolve modules in src/lib/entitlements.ts / entitlements-server.ts (available =
  plan allows ∧ tenant enabled). Add requireModule() and gate the compliance route groups
  (controls, clauses, coverage, frameworks, mapping, policies, audits, findings, risks,
  vendors, access-reviews, processes) at: nav (src/app/t/[tenantSlug]/(app)/layout.tsx),
  page (server check), and API (compose with withApiErrorHandling/requirePermission).
  Leave shared surfaces ungated: dashboard, tasks, calendar, notifications, onboarding,
  security, reports, search, issues, assets. New tenants default: ag modules ON,
  CERTIFICATION OFF. Add a module-gate-coverage guardrail (sibling of api-permission-coverage).
- Reference data: scripts/import-units.ts (UOM seed) + minimal input-product seed;
  scripts/seed-demo-farm.ts (replace compliance demo with a demo farm tenant).
- Light vocabulary pass in messages/en.json for the two personas (DEFER Prisma model renames).

Borrow: none — pure IC infra.
Done: tsc 0 errors; rls-coverage + module-gate-coverage green; a fresh tenant shows only
ag/shared nav, flipping CERTIFICATION on restores the full GRC surface; seed runs. Commit
to feat/phase0-platform and push. Then run MEMORY EXPORT.
```

## ▶ BUILD PROMPT 2 — Journal (the farm logbook)

```
Goal: the field journal — the daily logbook of activities, observations, inputs, harvests.

Build (lift schema from ag-saas/prisma-draft/agriculture.prisma): LogEntry + LogQuantity
+ LogLocation + LogEquipment + LogEntryFile; generalize Asset→Equipment; reuse the
Feature-1 Location. farmOS Log/Quantity ontology (type, occurredAt, status PLANNED/DONE,
quantities of measure/value/unit, links, photos via FileRecord, optional costAmount).
RLS trio + back-relations. Copy the Assets module end-to-end for usecases/repository/
routes (src/app/api/t/[tenantSlug]/journal…) and UI (list + detail with photo logging;
TipTap notes, sanitized). Emit logEvent. swr-keys via makeResource('journal').

Borrow: farmOS Log/Asset/Quantity ontology ⚖️ (reimplement, no code); HortusFox
photo/calendar/reminder UX ✅; Ekylibre intervention/cost concept ⚖️ (costAmount).
Done: create activity/observation/input/harvest entries with quantities + photos; list/
detail pages; audit events; unit tests; tsc clean; rls-coverage green. Commit to
feat/journal, push, MEMORY EXPORT.
```

## ▶ BUILD PROMPT 3 — Inventory (items, lots, append-only ledger)

```
Goal: track seeds/fertilizer/pesticide/harvest stock with a traceability-grade ledger.

Build (lift from ag-saas/prisma-draft/inventory.prisma): extend the Feature-1 Item; add
InventoryLot, StockTransaction (APPEND-ONLY, hash-chained exactly like AuditLog —
immutability trigger + a no-direct-stock-writes guardrail + a chain-verify script twin of
scripts/verify-audit-chain.ts), LotLink (genealogy). Reuse Feature-1 Location for storage
bins. RLS trio. WIRE: harvest LogEntry → HARVEST_IN lot; spray OperationParcel marked DONE
→ CONSUMPTION transaction + LogEntry(INPUT_APPLICATION) [this lands the Feature-1 deferred
item]. Low-stock alerts via a BullMQ job (src/app-layer/jobs) + existing notifications.

Borrow: InvenTree schema ✅ (translate Django→Prisma, attribute in THIRD_PARTY_NOTICES);
ERPNext stock-ledger concept ⚖️; OFBiz lot genealogy ✅.
Done: receive stock; spray completion deducts stock + writes a journal record; harvest
creates a lot; a traceability query walks seed-lot→field→harvest-lot; low-stock
notification fires; tests; tsc; immutability + chain guardrails green. Commit to
feat/inventory, push, MEMORY EXPORT.
```

## ▶ BUILD PROMPT 4 — Farm tasks & scheduling

```
Goal: assignable farm work tied to places/crops, with a calendar — building on IC's
existing Task module (don't rebuild it).

Build: add agriculture task types (LiteFarm catalog) and extend TaskLinkEntityType with
PLANTING/EQUIPMENT (LOCATION/PARCEL already added in Feature 1); let tasks link to
Location/Parcel/Equipment (+Planting later). Surface farm tasks in the existing calendar
route; worker/operator assignment + "assigned to me" view. Reuse usecases/task.ts +
TaskLink + assignment notifications unchanged.

Borrow: LiteFarm task-type catalog ⚖️ (names/categories only).
Done: create/assign farm tasks linked to locations/parcels/equipment; calendar shows
them; operator sees their queue; tests; tsc clean. Commit to feat/farm-tasks, push,
MEMORY EXPORT.
```

## ▶ BUILD PROMPT 5 — Knowledge base

```
Goal: versioned SOPs + growing guides workers can read and acknowledge — by repurposing
IC's policy machinery.

Build: model KnowledgeArticle/KnowledgeArticleVersion/KnowledgeAcknowledgement after
Policy/PolicyVersion/PolicyAcknowledgement (src/app-layer/usecases/policy*, the
Policy models in compliance.prisma) — DRAFT→PUBLISH→ACKNOWLEDGE lifecycle, categories,
TipTap content (sanitized), search via the existing search surface. Seed content from
OpenFarm (CC0) via scripts/import-knowledge.ts; follow frappe/wiki for feature shape.

Borrow: frappe/wiki feature spec ✅; OpenFarm growing-guide data (CC0) ✅; Growstuff API.
Done: create/version/publish articles; workers acknowledge (tracked); category browse +
search; seed loads CC0 guides; tests; tsc clean. Commit to feat/knowledge-base, push,
MEMORY EXPORT.
```

## ▶ BUILD PROMPT 6 — Integration, personas, demo, verification

```
Goal: make it one coherent product for both a startup farmer and a large grain producer.

Build: ag dashboard widgets (react-grid-layout) + navigation; "simple mode" (startup
farmer) vs enterprise via TenantModuleSettings + Stripe tiers in entitlements
(assertWithinLimit re-keyed to users/locations); persona onboarding wizard
(src/lib/onboarding-steps.ts). End-to-end demo seed: one startup-farm tenant + one
enterprise Organization with several child farms (exercise the hub-and-spoke). Make full
CI/guardrails green; run a smoke pass.

Done: both personas usable end-to-end (login → see only their modules → core flows work);
demo seed produces both; CI + all guardrails green; tsc 0; a short manual verification
log. Commit to feat/integration, push, FINAL MEMORY EXPORT.
```

---

## Notes

- Each build prompt names its schema source (`prisma-draft/*`), the IC pattern to copy
  (Assets/Policy/Task modules), the repo to borrow from with its license posture
  (per `REPOS.md`), and a concrete Done-gate ending in commit + MEMORY EXPORT.
- The export→import loop is closed: export writes `ag-saas/MEMORY.md` into the agri-saas
  repo; the import prompt reads it first, so status/decisions survive across sessions.
- License hygiene is non-negotiable: never copy GPL/AGPL code; port only MIT/Apache/BSD/CC0
  with attribution in `THIRD_PARTY_NOTICES.md`. See `REPOS.md`.
