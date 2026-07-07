# Soil Integration Prompt (#37) — per-parcel soil, colored on the map, wired into crop planning

Adds real soil data (open, commercial-safe: **ISRIC SoilGrids 250 m, CC-BY 4.0**) to every
parcel, **colors parcels by soil type on the location map**, and **surfaces the soil map inside
crop planning** with soil-aware crop/variety suitability. Runs in the agri-saas session
(depends on Feature 1 map + #9 crop planning; pairs with the agronomy copilot #18/#25). Paste
`MEMORY-EXPORT.md` at the end.

```
Goal: give every parcel its soil profile from open data, paint the location map by soil type,
and use soil to inform crop planning. Data source: ISRIC SoilGrids 2.0 (CC-BY 4.0, commercial-OK)
— models, NOT field surveys, so ALWAYS surface uncertainty and label it an estimate. Do NOT use
HWSD or ESDAC/LUCAS (non-commercial). Attribution required.

Build — DATA:
- Extend Parcel (prisma/schema/agriculture.prisma): add soilType String? (human label, e.g. WRB
  group or texture class) + soilJson Json? (structured: wrbClass, textureClass, sandPct, siltPct,
  clayPct, phH2o, socGkg, bulkDensity, depth, uncertainty/quantiles, provider, fetchedAt).
  Migration via create-only → RLS already applies (Parcel is tenant-scoped) → migrate deploy.
- A GLOBAL soil cache table SoilSample (NO tenantId — global, like Unit/CropVariety; catalog-RLS
  variant) keyed by rounded lat/lon (e.g. 3 decimals ≈ 100 m) storing the SoilGrids response, so
  we never refetch a nearby point and we respect fair-use. TTL effectively infinite (soil is static).
- Soil fetch service (src/app-layer/usecases/soil.ts): compute the parcel centroid via
  src/lib/db/geo.ts (ST_Centroid → lon/lat), check SoilSample cache, else call the provider.
  Provider behind config (SOIL_PROVIDER / SOIL_BASE_URL): default SoilGrids REST
  (https://rest.isric.org/soilgrids/v2.0/properties/query?lon=&lat=&property=clay&property=sand
  &property=silt&property=phh2o&property=soc&property=bdod&depth=0-5cm&value=mean&value=uncertainty),
  with a FALLBACK path (ISRIC WCS point extraction or a self-hosted SoilGrids/OpenLandMap COG) since
  the REST API is beta/rate-limited (~5 req/min). Derive textureClass from sand/silt/clay (USDA
  triangle) and map to a soilType label. Run fetches via a BullMQ job (reuse src/app-layer/jobs)
  with a queue-level rate limiter honoring 5/min; trigger the job on parcel import (#Feature 1
  spatial-import), parcel create, and geometry edit. Emit logEvent (SOIL_FETCHED). Attribution:
  add SoilGrids CC-BY to THIRD_PARTY_NOTICES.md + an in-app "Soil: SoilGrids (ISRIC), CC-BY" credit.

Build — LOCATION MAP COLORING (MapCanvas):
- Add a "Soil" view mode to src/components/ui/map/MapCanvas (alongside the existing crop/operation
  views): color each Parcel polygon by its soil class (fill by soilType/textureClass) with a legend
  and a view toggle. Use a COLORBLIND-SAFE categorical palette, consistent in light+dark, one color
  per soil class; parcels without soil yet render as a neutral hatched "pending" style. Clicking a
  parcel shows its soil profile (texture, pH, SOC) + uncertainty in the existing bottom-sheet/side
  panel. Keep all ST_* in geo.ts.

Build — CROP PLANNING INTEGRATION (#9):
- Show soil on the crop-planning surfaces: each Planting/field displays its parcel's soil summary;
  add the same soil-colored parcel layer to the crop-planning map view (reuse the MapCanvas soil mode).
- Soil-aware SUITABILITY (suggestions, never automation): given a parcel's soil (textureClass, phH2o,
  drainage implied by texture) and a CropType/CropVariety's agronomic defaults (preferred pH range,
  soil/drainage preference in defaultsJson), compute a simple suitability flag (good / caution / poor)
  with a plain-language reason, shown when planning a crop on that parcel; feed the reason to the
  agronomy copilot (#18/#25) for the "why / what to do". Pull thresholds from catalog data, never
  fabricate agronomic numbers.
- (Optional) A national soil-type base overlay: ship the AI4SoilHealth 30 m WRB map of Europe
  (Zenodo 10.5281/zenodo.13838408, CC-BY) as self-hosted vector/raster tiles behind a toggle for
  regional context — clearly separate from the per-parcel SoilGrids values.

Honesty & guardrails: label soil as a modeled ESTIMATE with uncertainty (SoilGrids quantiles), never
present it as a lab result; suitability is advisory ("verify with a soil test / agronomist"); cache
+ rate-limit so we stay within SoilGrids fair-use; graceful degradation when the provider is down
(show "soil pending", never block parcel creation).

Reuse: geo.ts (ST_Centroid), BullMQ jobs + rate limiter, MapCanvas + legend, crop-planning (#9)
CropType/CropVariety defaults, agronomy copilot, FileRecord/notes patterns, RLS catalog policy.
Done: importing parcels auto-populates soil (job) with attribution; the location map has a Soil view
that colors parcels by class with a legend + toggle; crop planning shows per-field soil + suitability
flags and the soil layer; cache + fallback + rate-limit verified; uncertainty shown; tsc 0;
rls-coverage green; unit tests for the USDA texture-class + suitability logic. Commit feat/soil,
push, MEMORY EXPORT.
```

**Notes for whoever runs it**
- SoilGrids is the only open, commercial-OK, per-point option that covers Bulgaria; it's a **model,
  not a survey** — the uncertainty surfacing is non-negotiable for an agronomy product.
- The REST endpoint is beta and throttled — the cache + BullMQ rate limiter + WCS/COG fallback in the
  prompt exist for that reason; don't skip them.
- There is **no open authoritative Bulgarian national soil map**; the ISSAPP ("N. Poushkarov") map
  must be licensed directly if you ever want survey-grade national data. The AI4SoilHealth 30 m WRB
  layer is the best open *soil-type* base for the region.
