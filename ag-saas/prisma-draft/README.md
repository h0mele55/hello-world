# Agriculture SaaS — Prisma schema draft (Phase 0/1)

Draft domain schemas for the agriculture management SaaS built on the
inflect-compliance platform fork. Written in the inflect house style
(GAP-09 multi-file schema, cuid IDs, soft-delete trio, composite
`[id, tenantId]` cross-tenant barrier, enums centralized).

## Files

| File | Destination in fork | Phase |
|---|---|---|
| `enums-additions.prisma` | append to `prisma/schema/enums.prisma` | 0–1 |
| `agriculture.prisma` | `prisma/schema/agriculture.prisma` | 0 (Location, Season, TenantModuleSettings, catalogs) + 1 (LogEntry et al.) |
| `inventory.prisma` | `prisma/schema/inventory.prisma` | 1 |
| `planning.prisma` | `prisma/schema/planning.prisma` | 1 (models) / 2 (engine) |

## Entity map

```
Tenant ─┬─ TenantModuleSettings          (module gating, WP-2)
        ├─ Season ──── CropPlan ──── Planting ───────────────┐
        ├─ Location (tree, PostGIS geometry)                  │
        │     └── InventoryLot.location / StockTx from/to     │
        ├─ Equipment                                          │
        ├─ LogEntry ─┬─ LogQuantity (measure/value/Unit)      │
        │  (journal) ├─ LogLocation ──→ Location              │
        │            ├─ LogEquipment ─→ Equipment             │
        │            ├─ LogPlanting ──→ Planting ←────────────┘
        │            ├─ LogEntryFile ─→ FileRecord (existing)
        │            └─ StockTransaction (CONSUMPTION/HARVEST_IN)
        └─ Item ── InventoryLot ── StockTransaction (hash-chained ledger)
                        └─ LotLink (split/merge genealogy)

Global catalogs (tenantId NULL): CropType, CropVariety, Unit
Reused untouched: User, Task, FileRecord, Notification, AuditLog,
                  Organization hub-and-spoke, billing, automation
```

## Integration checklist (when landing in the fork)

1. **Back-relations** — add the relation lists documented in each
   file header to `Tenant`, `User`, `Task` (Prisma requires both
   sides). Grep for `REQUIRED EDITS ELSEWHERE`.
2. **PostGIS** — `extensions = [postgis]` + preview flag in
   `base.prisma`; `CREATE EXTENSION` migration must run on the
   direct (non-PgBouncer) connection. Geometry access only via
   `src/lib/db/geo.ts`.
3. **RLS migrations** — standard tenant_isolation policies for every
   new table; catalog variant (`tenantId IS NULL OR …`) for
   CropType/CropVariety; Unit is global (no tenantId, no RLS).
   `tests/guardrails/rls-coverage.test.ts` is the gate.
4. **Immutability triggers** — StockTransaction gets the AuditLog
   no-UPDATE/no-DELETE trigger; add `no-direct-stock-writes` and
   chain-verification guardrails mirroring the audit ones.
5. **Denormalized caches** — `InventoryLot.quantityOnHand`,
   `Location.areaHa`, `Equipment.meterValue` are write-path-computed;
   never exposed as writable in Zod schemas/DTOs.
6. **Usecase invariants** — CONSUMPTION/HARVEST_IN require
   `logEntryId`; ADJUSTMENT requires `reason`; lot unit fixed at
   creation; last-resort DB triggers optional.
7. **Audit events** — every state-changing usecase emits `logEvent`
   (`LOCATION_CREATED`, `LOG_ENTRY_RECORDED`, `STOCK_RECEIVED`, …);
   extend the audit-event-coverage guardrail list.
8. **Seeds** — `scripts/import-units.ts` (UOM), `scripts/import-crops.ts`
   (OpenFarm CC0 → CropType/CropVariety; record provenance in
   `THIRD_PARTY_NOTICES.md`), `scripts/seed-demo-farm.ts`.

## License lineage

- InvenTree (MIT) — inventory schema translated; attribute it.
- Permastead (MIT) — planting-record shape.
- farmOS (GPL-2.0), Qrop/CropPlanning (GPL-3.0), Ekylibre (AGPL-3.0),
  ERPNext (GPL-3.0), LiteFarm (GPL-3.0) — **concepts only**, no code
  copied; enforced by the planned `license-hygiene` guardrail.
- OpenFarm data (CC0) — seed content for crop catalogs.
