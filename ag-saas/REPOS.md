# Open-source repo analysis + borrow matrix (durable memory)

Researched in the originating session as candidate bases / donors for the
agriculture SaaS. Verdict: **don't fork any of them** — build on the IC platform
and borrow selectively. Legend: ⚖️ = concept/UX reference only (GPL/AGPL — no code
copied); ✅ = code/schema/data portable (MIT/Apache/BSD/CC0, keep attribution).

## Top candidates evaluated

| Repo | ~Stars | License | Stack | Role for us |
|---|---|---|---|---|
| LiteFarm (LiteFarmOrg/LiteFarm) | 219 | GPL-3.0 ⚖️ | React/Node/PG | best modern feature ref; multi-farm RBAC, task catalog, cert export |
| farmOS (farmOS/farmOS) | 1.3k | GPL-2.0 ⚖️ | Drupal/PHP | the journal ontology (Log/Asset/Quantity/Plan); Field Kit (offline ref) |
| farmOS-map (farmOS/farmOS-map) | — | **MIT ✅** | OpenLayers | the one portable map lib (we chose MapLibre instead → ref) |
| ERPNext + frappe/agriculture | 35k / 93 | GPL-3.0 ⚖️ | Frappe/Python | stock-ledger design, UOM, crop_cycle doctypes; frappe/wiki (MIT) = KB |
| Odoo CE (odoo/odoo) | 52k | LGPL-3.0 ⚖️ | Python/PG | lot traceability + Maintenance module patterns |
| Tania (usetania/tania-core) | 813 | **Apache-2.0 ✅** | Go/Vue | smallholder "simple mode" model (dormant since ~2020) |
| Ekylibre (ekylibre/ekylibre) | 480 | AGPL-3.0 ⚖️ | Rails/PostGIS | intervention model → per-activity cost accounting; campaign/season |
| InvenTree (inventree/InvenTree) | 7.1k | **MIT ✅** | Django/React | main inventory schema donor (Part/Stock/Lot/transactions) |
| HortusFox (danielbrendel/hortusfox-web) | 1.6k | **MIT ✅** | PHP/Vue | lightweight journal/calendar/reminder + photo-logging UX |
| Nekazari (nkz-os/nkz) | ~2 | AGPL-3.0 core / Apache SDK | React+Python/K8s | agronomic intelligence-layer blueprint (GDD/NDVI); SDK portable |
| Apache OFBiz | 1k | **Apache-2.0 ✅** | Java | lot genealogy (grain blending) + facility/UOM patterns |

## What to borrow, per future module

- **Journal (Phase 1/2):** farmOS Log/Asset/Quantity ontology ⚖️ (reimplement);
  HortusFox photo-logging UX ✅; Ekylibre intervention/cost concept ⚖️.
- **Inventory (Phase 2):** InvenTree schema ✅ (translate Django→Prisma); ERPNext
  append-only stock-ledger concept ⚖️ (implement with IC's hash-chain); OFBiz lot
  genealogy ✅.
- **Crop planning (Phase 2):** Qrop/CropPlanning succession math ⚖️ (GPL — reimplement
  date arithmetic, seed-qty, bed allocation); Permastead schema ✅ (MIT); LiteFarm
  task-type catalog ⚖️.
- **Knowledge base (Phase 2):** frappe/wiki feature spec (MIT) ✅; OpenFarm growing
  guides as **CC0 ✅ seed content**; Growstuff open crop API (data).
- **Certification (Phase 2):** repurpose IC Framework/Evidence/AuditPack; LiteFarm
  organic-cert export ⚖️ as the feature spec.
- **Geospatial (Phase 1, Feature 1):** **MapLibre GL (BSD-3) ✅** + react-map-gl +
  terra-draw (MIT) ✅; file parsing via **shpjs (MIT) ✅** + **@tmcw/togeojson (BSD-2)
  ✅**. farmOS-map (MIT) / agro-gis / PermaplanT as UX references.
- **Risk/intelligence (Phase 3):** Nekazari GDD/disease/NDVI architecture ⚖️ (+ Apache
  SDK ✅); IC Risk + matrix + treatment-plan models repurposed.

## Spray-map feature specifics (Feature 1)

Map stack decision = **MapLibre GL** (not farmOS-map). Spatial-file import is **not
ported from any repo** — it's standard libs (shpjs, @tmcw/togeojson). Per-parcel task
assignment has no separable OSS donor → custom, built on IC's Task module. Avoid
`react-leaflet` (Hippocratic license) if using Leaflet; we use MapLibre anyway.

## Excluded (wrong domain / unusable)

FarmBot (robot control), Open Food Network (marketplace, AGPL), AgOpenGPS (GPS
guidance), Grocy (single-household), Medusa/Twenty (e-commerce/CRM). OpenFarm code is
archived (but its data is CC0 — use that). Farmery is CC-BY-NC (non-commercial — unusable).
