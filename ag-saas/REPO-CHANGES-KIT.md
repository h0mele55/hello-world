# Repo Change Set — 16 scoped prompts (from a live scan of agri-saas)

Interactive artifact: published on claude.ai (favicon 🌾, "agrent-change-prompts").
Decisions locked with the user: brand **Agrent (agrent.bg)**, logo **prompt-only**; brand color
**metallic gold #D4AF37** (replaces METRO yellow #FFCD11); Exchange/Offers/insurer/climate =
**lead-gen placeholders**; journal = **official Bulgarian dnevnik columns**.

⚠️ Confirm two readings before running: **#2** (add per-culture filter + drop the overview
Farm-Records block + sort parcels by size — I did NOT delete the dnevnik PDF register) and **#3**
("crop selectable" read as **Fertilizer XOR Product** on the spray screen).

Each prompt is independent → its own branch + tests + `tsc 0` + MEMORY EXPORT. Pairings:
#7→#1, #9+#37, #13 builds on #9, #16+#18.

---

### #1 — Selected crop as an icon on each parcel (map) · net-new layer
```
Goal: show each parcel's crop as a small icon on the location map.
Build: thread Parcel.cropType into the MapParcel interface + the mapParcels array in
locations/[locationId]/page.tsx. In MapCanvas, render a crop icon per parcel as an HTML
<Marker> centered on the parcel bbox (reuse the parcelLabels Marker pattern + @turf/bbox;
pointerEvents:'none') — do NOT add a maplibre symbol layer / addImage (codebase avoids glyph
deps). Map cropType->icon via a small crop->glyph table (reuse CROP_OPTIONS; already-imported
lucide icons per the no-new-lucide guard, or tiny inline SVGs). Hide below a zoom threshold;
add a legend; update on cropType change.
Done: parcels show a live crop icon; no glyph/font dep; reduced-motion safe; tsc 0.
Commit feat/map-crop-icons, push, MEMORY EXPORT.
```

### #2 — Per-culture filter (visible chips) + parcel dropdown sorted by size · rework · CONFIRM
```
Goal: filter the Location by culture with visible chips, tidy the overview, sort parcel pickers by size.
Build: in the Location overview/records tabs (locations/[locationId]/page.tsx) add a per-culture
(cropType) filter as visible chips/blocks filtering the parcel list + records; REMOVE the current
Farm-Records summary block from the OVERVIEW (keep the dnevnik register on its own 'records' tab
+ its PDF intact). Sort every parcel dropdown DESC by areaHa (name tiebreak).
Done: culture chips filter; overview no longer duplicates records; parcel dropdowns sorted desc; tsc 0.
Commit feat/culture-filter-parcel-sort, push, MEMORY EXPORT.
(!) Confirm interpretation — do NOT delete the farm-record register unless intended.
```

### #3 — Spray job = the single parcel on-click screen · rework · CONFIRM
```
Goal: clicking a parcel opens ONE screen that IS the create-task form — no separate wizard.
Build: make ParcelDetailSheet the single spray-job screen. REMOVE the QrCode block and its
standalone apply-rate calculator. Inline the sections on one screen: an EXCLUSIVE selector —
Fertilizer XOR Product (never both) — then dose + unit (/units?measure=RATE), water carrier,
operator (UserCombobox), application technique (БАБХ), note; running total via the shared
rate-calc.ts totals panel (totalLabel/haToDca), not a bespoke calculator. Retire the 7-step
SprayJobWizard (fold fertilizer/water/technique + 'repeat last job' + offline submit in; keep
StepWizard only if a phone truly needs paging). Enforce fertilizer-XOR-product in
CreateFieldOperationSchema + createFieldOperation. Keep POST /locations/{id}/operations + OperationParcel.
Done: one click -> one screen; no QR, no separate calculator/wizard; fertilizer/product exclusive
(schema-enforced); totals from inputs; tsc 0. Commit feat/spray-single-screen, push, MEMORY EXPORT.
```

### #6 — Approve/Review step on task completion · net-new gate
```
Goal: a completed field-operation must be reviewed/approved before it's final.
Build: when the last parcel line is DONE, set the Task to a new PENDING_REVIEW state (add to
WorkItemStatus) instead of auto-RESOLVED. Add field-operations/{taskId}/review with
Approve / Request-changes + comment, for canWrite/reviewer (not the executing operator) —
mirror the reviewEvidence state machine + notifications (evidence.ts). Approve -> RESOLVED +
finalize (keep recordInputApplication + auto-evidence chain); Request-changes -> reopen lines.
Surface controls on the FIELD_OPERATION task detail page; log TASK_STATUS_CHANGED + notify.
Document whether task-approval and Evidence approval are one action or two.
Done: all-lines-done -> PENDING_REVIEW; reviewer approves/rejects w/ comment; audit + notify; tsc 0.
Commit feat/task-review-gate, push, MEMORY EXPORT.
```

### #7 — Crop step in the shapefile import → icon on the block · net-new step
```
Goal: choose the crop before importing a shapefile, and stamp it on every parcel.
Build: add a crop step to SpatialImportModal (crop-type select from CROP_OPTIONS, allow
"mixed/set later"). Thread cropType: POST /locations/{id}/spatial-import (form field) -> route
-> stageLocationSpatialImport (SpatialImportInput) -> job payload -> replaceForLocation (which
currently ignores cropType): set Parcel.cropType on every inserted parcel. With #1, blocks then
show their crop icon.
Done: import asks crop first; imported parcels carry cropType; map icons reflect it; tsc 0.
Commit feat/import-crop-step, push, MEMORY EXPORT.
```

### #9 — Crop planning at the parcel level · rework
```
Goal: plan crops per parcel, not per whole location.
Build: add parcelId to CropPlan (plan targets a parcel / set of parcels in a location); migration
(RLS applies). Populate Planting.parcelId in src/lib/planning/succession.ts + crop-planning.ts
(today only locationId). Add parcel selection to NewCropPlanModal (sorted by size desc per #2).
Add a Parcel column to PlantingBoard + [cropPlanId]/page.tsx; filter/group by parcel. Fix the
AgroSignal.plantingId -> parcel chain. Ties into #37 (soil) + #13 (per-parcel AI).
Done: plan on a specific parcel; plantings carry parcelId; board shows/filters by parcel;
tsc 0; rls-coverage green. Commit feat/planning-per-parcel, push, MEMORY EXPORT.
```

### #10 — Journal history → dnevnik table + filters · rework
```
Goal: make the journal history the official Bulgarian field logbook (dnevnik), filterable.
Build: reshape JournalClient columns to the regulated set — Date, Parcel/Culture, Operation,
Product + active ingredient, Dose/Rate, Treated area, Operator, PHI, Weather, Notes — sourcing
from LogEntry.conditionsJson + linked operationParcel + quantities. Add filters (filter-defs.ts
+ JournalQuerySchema + list usecase/repo): date-range, location, parcel, crop, operation type,
operator, status. Keep mobile card fallback. Match columns to reports/pdf/farm-record-diary.ts
so screen == PDF; Bulgarian labels via i18n (bg.json), emoji-free.
Done: dnevnik columns render; filters work; screen == PDF; tsc 0. Commit feat/journal-dnevnik-table,
push, MEMORY EXPORT.
```

### #11 — Exchange: buy categories + map filter · extend existing
```
Goal: buy culture/fertilizer/seeds/products in the existing Exchange, filter the map by category.
Build: add categories CULTURE, FERTILIZER, SEEDS, PRODUCT to the listing category enum +
CreateOfferModal + exchange/filter-defs.ts + listings API. Add a category filter to ExchangeMap
(reuse exchange-map-utils.ts) and the list. "Buy" = lead-gen: reuse InquiryModal (no cart/payment).
Category-color the markers.
Done: four categories browsable; map filters by category; inquiry per listing; tsc 0.
Commit feat/exchange-categories, push, MEMORY EXPORT.
```

### #12 — Offers page (company promotions feed) · net-new
```
Goal: an "Offers" (Промоции) page — a scrollable feed of company promotions, each with "Ask for offer".
Build: a Promotion model (GLOBAL: nullable tenantId / provider dimension, catalog-RLS, readable
by all tenants) — company, title, body, media, category, validFrom/To, ctaUrl. A scrollable feed
page (card per promotion, styled like the journal list). Each card has "Ask for offer" -> a
lead/inquiry form (reuse Exchange InquiryModal) capturing user + optional parcel/context ->
Lead row + notify. Add an "Offers" nav entry in useNavSections (reuse imported icon) + i18n en/bg;
seed demo promotions; admin/seed posts (lead-gen, no billing).
Done: Offers in nav; feed scrolls; "Ask for offer" creates a lead + notifies; global visible to
all tenants; tsc 0; rls-coverage green. Commit feat/offers-page, push, MEMORY EXPORT.
```

### #13 — New Risk: per-parcel AI from satellite + insurer offer · replace surface
```
Goal: replace the farm "Risk" nav with a per-parcel satellite-AI risk page that can request an
insurance offer.
Build: keep the GRC risk module gated behind CERTIFICATION (don't delete) but remove it from the
farm nav. Add a farm Risk page:
- polygon-AOI variant of getIndexMeansForBounds in src/lib/agro/earth-engine.ts reducing a single
  Parcel.geometry as the EE region (today: whole-location bbox);
- a parcel-analysis usecase + route (/agro/parcel-analysis?parcelId=) -> per-parcel NDVI/NDMI +
  anomaly, summarized by Claude (reuse ai/field-briefing + satellite-briefing, Redis-cached);
- persist per-parcel results (parcel dimension on AgroSignal or a new ParcelRiskAssessment);
- a page listing per-parcel risk + the same colors on the location map;
- an "Ask for offer" (insurance) button per parcel -> lead form (reuse inquiry/lead) — lead-gen.
Repoint the SidebarNav Risk entry to this page for farm tenants.
Done: farm nav shows per-parcel Risk; each parcel gets AI satellite risk + insurer "ask for
offer"; GRC risk still under certification; tsc 0; rls-coverage green. Commit feat/risk-parcel-ai,
push, MEMORY EXPORT.
```

### #14 — Climate nav (Meteobot) · net-new placeholder
```
Goal: a "Climate" (Климат) nav entry linking to Meteobot.
Build: add a Climate nav item in useNavSections (reuse imported icon) -> a Climate page embedding/
linking the tenant's Meteobot station (iframe/embed or external link). Store a per-tenant Meteobot
station id/URL in tenant settings. Placeholder now (link/embed) with a seam for the real Meteobot
API later; Open-Meteo weather as fallback content. i18n en/bg.
Done: Climate in nav; opens Meteobot embed/link (or weather fallback); station URL per tenant;
tsc 0. Commit feat/climate-meteobot, push, MEMORY EXPORT.
```

### #15 — Agriculture events nav · net-new
```
Goal: an "Agriculture events" (Събития) nav entry with an events feed.
Build: an AgriEvent model (GLOBAL / nullable tenantId, catalog-RLS) — title, description,
startsAt/endsAt, place, url, category (fair/training/webinar/subsidy-deadline), isGlobal. A page
listing upcoming events (scrollable cards or a light calendar); seed a few; admin/seed posts. Add
the nav item (reuse imported icon) + i18n en/bg. Optional: surface subsidy deadlines in the
calendar badge.
Done: events in nav; upcoming list; global visible to all tenants; tsc 0; rls-coverage green.
Commit feat/agri-events, push, MEMORY EXPORT.
```

### #16 — Agrent logo replaces "AG" · rework
```
Goal: replace the placeholder "AG" initials with a proper Agrent (agrent.bg) logo everywhere.
Build: create an Agrent logo (SVG mark + wordmark) as a React component / public asset using the
golden brand tokens (--brand-*), working light + dark with animate-nav-brand-pulse. Use it in
NavBarBrand (nav-bar.tsx). Fix the stale legacy 'IC' mark in the sidebar header (SidebarNav.tsx
~L262) and the org initial (OrgSidebarNav.tsx, org-switcher.tsx). Keep link->dashboard, aria-label
"Agrent — go to dashboard", data-testid nav-bar-brand.
Done: Agrent logo top-left (+ sidebar/org); no AG/IC initials; gold tokens + dark + reduced-motion;
tsc 0. Commit feat/agrent-logo, push, MEMORY EXPORT.
```

### #17 — Location table: remove row-select, open on single row click · small
```
Goal: no selection checkboxes on the locations list; single click anywhere on a row opens it.
Build: in LocationsClient remove selection (drop batchActions / selectionEnabled={false}; relocate
or remove bulk-delete). Add onRowClick={(row) => router.push(`/t/${tenantSlug}/locations/${row.original.id}`)}
(DataTable already supports onRowClick — used on the detail parcel sub-table). Keep the name cell
keyboard-accessible; stopPropagation on interactive cells; add hover/pointer affordance.
Done: no checkboxes; single click opens; keyboard works; tsc 0. Commit feat/locations-row-click,
push, MEMORY EXPORT.
```

### #18 — Brand color → metallic gold #D4AF37 · small · wide
```
Goal: replace the METRO yellow brand with metallic gold #D4AF37.
Build: in src/styles/tokens.css set:
  --brand-default:#D4AF37; --brand-emphasis:#B8860B; --brand-muted:#E4C55C;
  --brand-subtle:rgba(212,175,55,0.16); --bg-inverted:#D4AF37;
  --ring-default:rgba(212,175,55,0.55); --primary:#D4AF37;
  --chart-series-1-start:#D4AF37; --chart-series-1-end:#B8860B;
Verify --content-inverted (#001830 navy) on gold meets WCAG AA for buttons (keep it). Grep for
hardcoded #FFCD11/#E6B800/#FFE066 and replace. Do NOT touch the unrelated legacy numeric `brand`
(indigo #6366f1) scale in tailwind.config.js. Check light + dark + the nav-brand pulse.
Done: brand reads metallic gold across nav/buttons/links/focus/charts, light + dark, AA contrast,
no yellow stragglers; tsc 0. Commit feat/brand-gold, push, MEMORY EXPORT.
```
