# Agriculture Journal & Management System
## Deep Code Audit of LiteFarm + Portability Plan for an `inflect-compliance` Frontend

**Document type:** Architecture audit + portability/build plan
**Subject of audit:** [LiteFarmOrg/LiteFarm](https://github.com/LiteFarmOrg/LiteFarm) (`integration` branch)
**Target product:** A new SaaS — *Agriculture Journal & Management System* ("Agri-Journal") — combining a compliance-oriented frontend with LiteFarm's proven business logic and backend design.
**Date:** 2026-06-01

---

## 0. How to read this document (scope, method, and honest limitations)

- **What was actually inspected.** The container environment's network policy blocked `git clone` and most GitHub HTTP endpoints, so this is **not a line-by-line source audit**. It is an **architecture- and manifest-level audit** built from authoritative artifacts I *was* able to retrieve: `packages/api/package.json`, `packages/webapp/package.json`, the `LICENSE` file, the project README, and the official LiteFarm engineering docs (Confluence "Tech Stack Onboarding" and "A tour of the codebase"). Every stack claim below traces to one of those.
- **What this means for you.** The findings on architecture, dependencies, licensing, and design patterns are reliable. Findings that require reading source (e.g., specific SQL-injection vectors, dead code, test coverage %) are flagged as **[NEEDS SOURCE PASS]** — I can complete those once cloning is enabled.
- **The one assumption I had to make.** "**inflect-compliance frontend**" is not a uniquely identifiable public product (the closest market matches are Inflectra/SpiraPlan compliance tooling, which is something else). I have therefore treated it as **a compliance-oriented React frontend / design system that you own or control** — i.e., a UI layer built around audit trails, regulatory reporting, and record-keeping. The portability plan is deliberately built on an **anti-corruption / adapter boundary** so it holds regardless of exactly what `inflect-compliance` turns out to be. **§12 lists what I need from you to finalize.**

---

## 1. Executive summary

LiteFarm is a mature, well-structured **monorepo** farm-management platform: a **React 18 + Redux-Saga** PWA frontend, a **Node 22 + Express + Objection/Knex + PostgreSQL** REST backend, and a **Bull/Redis** job-scheduler that produces certification/export documents. Its domain model (farms, locations/fields, crops, management plans, tasks, logs, certifications) is **directly reusable** for an Agriculture Journal & Management product — in fact LiteFarm already ships a *certification export service*, so the compliance/record-keeping DNA is present.

The decisive finding is **legal, not technical**: LiteFarm is **GPL-3.0** (strong copyleft) — **but not AGPL**. That distinction is the whole ballgame for a SaaS (see §4):

- ✅ Running a *modified* GPL-3.0 backend **as a hosted SaaS** does **not**, by itself, force you to publish your source (GPL-3.0 has **no network-use clause**).
- ⚠️ **Distributing** the backend (on-prem, customer-hosted, downloadable binaries) **does** force full source release under GPL-3.0.
- ⚠️ Your proprietary `inflect-compliance` frontend must be architected as a **separate work communicating at arm's length over the REST API** to avoid being construed as a GPL derivative.

**Recommended strategy:** Treat LiteFarm's **backend + domain model as a GPL-3.0 service you fork and host**, keep your **`inflect-compliance` frontend as a separate proprietary work** talking to it through a thin **Backend-for-Frontend (BFF) / adapter**, and add the **journal + compliance domain extensions** that differentiate the product. Get a written legal opinion before launch.

---

## 2. LiteFarm architecture overview

### 2.1 Monorepo layout
Per the official docs, the monorepo defines **three packages** plus an embedded service:

| Package | Role |
|---|---|
| `packages/webapp` | React frontend (PWA), built with Vite + Storybook |
| `packages/api` | Node/Express REST backend, TypeScript entrypoint (`src/server.ts`) |
| `packages/shared` | Code shared across webapp/api |
| `packages/api/**` (embedded) | "exports" / "scheduler" / "job scheduler" — a **certification export service** |

Local dev runs three Docker containers: `litefarm-web`, `litefarm-api`, `litefarm-db`, with supporting services (Redis, MinIO, an "Imaginary" image-processing container).

### 2.2 Request/data flow (backend)
```
inflect-compliance frontend  ──REST/JSON──▶  Express controllers
                                                   │
                                          (route handler functions,
                                           grouped by entity type)
                                                   ▼
                                        Objection.js models  ──▶  Knex query builder  ──▶  PostgreSQL
                                                   │
                                   ┌───────────────┼──────────────────┐
                                   ▼               ▼                  ▼
                            Bull + Redis      AWS S3 / DO Spaces   Google Maps /
                          (export/cert jobs)   (files, exports)    geo services
```
Controllers = Express route-handler groups per entity; they call Objection models, which build on Knex; results returned as HTTP/JSON following REST conventions. Long-running work (certification PDFs, spreadsheet exports) is offloaded to the **Bull/Redis** queue and rendered via **Puppeteer / ExcelJS / xlsx-populate**.

### 2.3 Frontend design
Three conceptual component tiers (per docs):
- **Pure components** (`src/components`) — layout/rendering of props only.
- **Container/"smart" components** (`src/containers`) — hold logic, connect to Redux, dispatch actions, render pure components.
- **Sagas/actions/reducers** colocated within container folders when logic is component-specific.

State is **Redux + Redux Toolkit + Redux-Saga + redux-persist + immer**. UI is **MUI 5 (+ Emotion)**. Forms use **react-hook-form** *and* legacy **react-redux-form**. Mapping uses **Google Maps JS API + terra-draw** (with a custom patch). It's a **PWA** (Vite PWA plugin). Full **i18next** localization, consistent with LiteFarm's global, multi-language mission.

---

## 3. Tech stack inventory (from manifests — authoritative)

### 3.1 Backend (`packages/api`, Node `22.21`)
| Concern | Library (version) | Audit note |
|---|---|---|
| HTTP framework | `express@^4.21.1`, `express-promise-router` | Current, stable |
| ORM / query | `objection@^3.0.1`, `knex@^3.1.0`, `objection-soft-delete` | Modern; soft-delete in domain |
| DB driver | `pg@^8.5.1` (PostgreSQL) | Current |
| AuthN/Z | `express-jwt@^8`, `jwks-rsa@^3`, `jsonwebtoken@^9`, `express-jwt-authz`, `google-auth-library` | JWT + JWKS → external IdP (Auth0/Google-style); Google SSO |
| Jobs/queue | `bull@^3.22.9` (Redis) | Bull v3 is **legacy** (BullMQ is the successor) — **upgrade candidate** |
| File/exports | `@aws-sdk/client-s3@^3`, `exceljs@4.3.0`, `xlsx-populate`, `adm-zip`, `puppeteer@^24` | DO Spaces (S3-compatible); Puppeteer = heavy but powerful PDF path |
| Email | `email-templates@^8` | — |
| Geo | `@googlemaps/google-maps-services-js`, `@turf/*` | Server-side geo calcs |
| Domain/interop | `@datafoodconsortium/connector@^1.0.0-alpha.10` | **Food-data interoperability** — relevant to compliance/traceability |
| Logging/observability | `winston`, `winston-daily-rotate-file`, `@sentry/node@^7` | Solid |
| Validation | `ajv-formats` | Schema validation present |
| **Deprecated/risky** | `request@^2.87.0`, `request-promise@^4` | **`request` is deprecated/unmaintained** — replace with `axios` (already a dep) **[NEEDS SOURCE PASS to scope usage]** |
| Tooling | TypeScript `5.6`, ESLint 9, Prettier, Jest 30, `@swc/*`, Chai/chai-http, Faker | API is **mid-migration to TypeScript** (SWC register, `tsconfig`, `@types/*`) |

### 3.2 Frontend (`packages/webapp`, Vite `4.5.5`)
| Concern | Library (version) | Audit note |
|---|---|---|
| Core | `react@^18.2`, `react-dom@^18.2` | Current major |
| State | `redux@^4.2`, `@reduxjs/toolkit@^1.9`, `react-redux@^7.2.9`, `redux-saga@^1.2`, `redux-persist`, `immer` | **react-redux v7** is behind (v8/v9 exist); RTK v1 (v2 exists) |
| UI | `@mui/material@^5.13`, `@mui/icons-material`, `@mui/styles`, `@emotion/*` | ⚠️ **`@mui/styles` is deprecated** (legacy styling engine) |
| Forms | `react-hook-form@^7.54`, `react-redux-form@^1.16` | **Two form paradigms** — `react-redux-form` is abandoned; tech-debt |
| i18n | `i18next@^25`, `react-i18next@^16`, http-backend, language-detector | Strong, modern i18n |
| Charts | `chart.js@^4`, `recharts@^2` | **Two charting libs** — consolidation opportunity |
| Maps | `@googlemaps/js-api-loader`, `terra-draw@1.28.8` (patched) | Patched dep = upgrade friction |
| Build/test | Vite 4.5, Vitest, Storybook | Modern build; ⚠️ **Vite 4 is behind** (v5/v6 exist) |

### 3.3 Infrastructure & third-party services
- **Storage:** Digital Ocean Spaces (S3-compatible) in prod; **MinIO** locally.
- **Auth:** JWT/JWKS + **Google SSO**.
- **Image processing:** "Imaginary" microservice (Docker).
- **Queue:** Redis (Bull).
- **Containerization:** Docker / Docker Compose.

---

## 4. License analysis — the decisive constraint (GPL-3.0)

**LiteFarm is licensed `GNU GPL-3.0` ("Version 3, 29 June 2007").** Verified from the repo `LICENSE`.

| Scenario | Triggers source disclosure? | Implication for Agri-Journal |
|---|---|---|
| Host a **modified** LiteFarm backend as **SaaS** (no binary distribution) | **No** — GPL-3.0 has **no network/SaaS clause** (unlike AGPL) | ✅ You may run a forked, modified backend as a hosted service without publishing source |
| **Distribute** the backend (on-prem, customer VM, downloadable, mobile binary embedding it) | **Yes** — must release **complete corresponding source** under GPL-3.0 | ⚠️ Avoid on-prem/self-host offerings unless you accept open-sourcing |
| Proprietary `inflect-compliance` frontend **tightly linked** to GPL code (same process, imports, shared memory) | **Likely yes** (derivative work) | ⚠️ Must keep frontend a **separate work** |
| Proprietary frontend talking to GPL backend **over REST at arm's length**, as a separate program | **Generally no** (separate works / mere aggregation argument) | ✅ Architect for this — it's the safe pattern |

**Practical rules for the build:**
1. **Never ship the backend as distributable software.** SaaS-only. (Or be prepared to GPL it.)
2. **Hard process boundary** between GPL backend and proprietary frontend — communicate **only** via the documented REST/JSON API. No shared libraries, no compiling frontend against GPL modules.
3. **Quarantine GPL code** in its own repo/service with clear provenance and a `NOTICE`/attribution trail.
4. **Any code you contribute *into* the forked backend is GPL-3.0.** Keep your differentiating, potentially-proprietary logic (billing, tenancy, premium compliance analytics) **outside** the GPL service where possible — e.g., in the BFF or a separate proprietary microservice.
5. **Get a written legal opinion** before commercial launch. This document is engineering guidance, not legal advice.

> Bottom line: GPL-3.0 (vs AGPL) is *workable* for SaaS, but only with disciplined architectural separation. The target architecture in §6 is designed around exactly this.

---

## 5. Code-quality & risk assessment

### 5.1 Strengths
- **Clean layered separation** (controllers → models → query builder) and a **disciplined component taxonomy** (pure/container/saga) — easy to reason about and to extend.
- **Active TypeScript migration** on the API (SWC, tsconfig, types) signals ongoing modernization.
- **Real observability** (Winston + Sentry) and **schema validation** (ajv) already in place.
- **i18n-first** — invaluable if Agri-Journal targets multilingual/EU markets.
- **Compliance-adjacent features already exist** (certification export service, `@datafoodconsortium/connector`).
- **Soft-delete** baked into the data layer — useful for audit/journal immutability requirements.

### 5.2 Tech-debt & risks (register)
| # | Finding | Severity | Action |
|---|---|---|---|
| R1 | **GPL-3.0 copyleft** governs all reuse | 🔴 High | Architectural separation + legal opinion (§4) |
| R2 | `request`/`request-promise` **deprecated/unmaintained** in API | 🟠 Med | Migrate to `axios` (already present) **[NEEDS SOURCE PASS]** |
| R3 | `bull@3` is **legacy** | 🟠 Med | Plan migration to BullMQ |
| R4 | Frontend carries **two form libraries** (`react-hook-form` + abandoned `react-redux-form`) | 🟠 Med | Standardize on react-hook-form during port |
| R5 | `@mui/styles` **deprecated** | 🟠 Med | Migrate to Emotion/`sx` styling |
| R6 | **Two charting libs** (chart.js + recharts) | 🟡 Low | Consolidate |
| R7 | Patched `terra-draw` + **Vite 4 / react-redux 7 / RTK 1** behind latest | 🟡 Low | Schedule upgrades; patched dep adds friction |
| R8 | **Puppeteer** in API = heavy runtime (headless Chromium) for PDF/cert exports | 🟠 Med | Isolate in the jobs service; size containers accordingly |
| R9 | Mixed **npm + pnpm** across packages | 🟡 Low | Standardize package manager |
| R10 | Test coverage unknown | 🟡 Low | **[NEEDS SOURCE PASS]** measure before refactor |
| R11 | Secrets/Google/JWKS config sprawl | 🟠 Med | **[NEEDS SOURCE PASS]** audit `.env`/secret handling before multi-tenant launch |

---

## 6. Target architecture for Agri-Journal

### 6.1 Principle: GPL backend behind an arm's-length API; proprietary frontend in front
```
┌─────────────────────────────────────────────────────────────┐
│  PROPRIETARY (your IP, any license)                           │
│                                                               │
│   inflect-compliance Frontend (React)                         │
│        │  calls only your own API contract                    │
│        ▼                                                       │
│   BFF / Adapter (proprietary)  ── Anti-Corruption Layer ──┐   │
│   - auth/session, multi-tenant routing                    │   │
│   - request/response mapping to inflect-compliance models │   │
│   - premium/compliance analytics, billing hooks           │   │
└───────────────────────────────────────────────────────────┼───┘
                                                              │ REST/JSON (documented contract)
┌─────────────────────────────────────────────────────────────┼───┐
│  GPL-3.0 (forked, hosted-only, never distributed)            ▼   │
│   LiteFarm-derived Core API (Express + Objection/Knex)            │
│   - farms, locations, crops, management plans, tasks, logs        │
│   - certification/export jobs (Bull/Redis, Puppeteer/ExcelJS)     │
│        │                                                          │
│        ▼                                                          │
│   PostgreSQL  +  Redis  +  S3-compatible object store             │
└───────────────────────────────────────────────────────────────┘
```

### 6.2 Why the BFF/Anti-Corruption Layer is non-negotiable
1. **License firewall** — keeps your proprietary frontend a *separate work* (§4).
2. **Model translation** — maps LiteFarm's domain shapes to `inflect-compliance`'s compliance/journal models without leaking LiteFarm internals into your UI.
3. **Differentiation surface** — your *new* value (journal immutability, audit trails, EU CAP/organic-cert reporting, multi-tenant billing) lives here, outside the GPL boundary.
4. **Upgrade insulation** — you can pull upstream LiteFarm fixes without rewriting the frontend.

### 6.3 Multi-tenancy (new — LiteFarm is farm-scoped, not SaaS-tenant-scoped)
LiteFarm models a **farm** with users/roles, but a commercial SaaS needs **tenant isolation**. Options:
- **Schema-per-tenant** (Postgres schemas) — strong isolation, moderate ops.
- **Row-level tenancy** (`tenant_id` + Postgres RLS) — simpler scaling, requires rigorous policy coverage. **Recommended** for SaaS scale.
- **[NEEDS SOURCE PASS]** confirm how LiteFarm scopes queries by `farm_id` to choose the least-invasive tenancy retrofit.

---

## 7. Reuse decision matrix

| LiteFarm asset | Verdict | Rationale |
|---|---|---|
| Domain data model (farms, locations, crops, plans, tasks, logs) | **KEEP** | Mature, directly maps to an ag journal |
| Objection/Knex models + migrations | **KEEP (in GPL service)** | Battle-tested; stay behind the API boundary |
| Certification/export jobs (Bull/Puppeteer/ExcelJS) | **KEEP & EXTEND** | Core to compliance reporting |
| Express controllers / REST conventions | **KEEP, harden** | Solid base; add tenancy + rate limiting |
| Auth (JWT/JWKS, Google SSO) | **ADAPT** | Re-point to your IdP; add tenant claims |
| i18n (i18next) | **KEEP** | Strong asset for EU/multilingual |
| Redux-Saga frontend, MUI, `react-redux-form` | **DISCARD / DO NOT PORT** | Replaced by `inflect-compliance` frontend; avoids GPL-frontend entanglement and the form/styling tech-debt |
| `@datafoodconsortium/connector` | **EVALUATE** | Potentially valuable for traceability interop |
| Maps (Google + terra-draw) | **ADAPT if geospatial fields needed** | Re-implement in your frontend stack |
| Bull v3, `request`, `@mui/styles` | **REPLACE** | Deprecated (see risk register) |

---

## 8. New domain: the "Journal & Compliance" differentiators

This is where Agri-Journal earns its name and its price. Build these in the **BFF + a proprietary extension service** (kept out of GPL where it's your IP):

1. **Immutable activity journal** — append-only, cryptographically chained (hash-linked) records of field operations (planting, spraying, harvest, inputs, observations). Leverages LiteFarm's logs + soft-delete, but adds tamper-evidence for audit.
2. **Regulatory reporting packs** — EU CAP record-keeping, **organic certification** evidence, plant-protection-product (PPP) / spray diaries, nutrient management plans, traceability (One-Up/One-Down). Extends the existing certification-export engine.
3. **Audit-ready exports** — signed PDF/CSV with provenance metadata (who/when/source), reusing Puppeteer/ExcelJS pipeline.
4. **Compliance dashboards** — deadline tracking, missing-record alerts, certification expiry — the `inflect-compliance` frontend's natural home.
5. **Interoperability** — evaluate `@datafoodconsortium/connector` for standardized food-data exchange.

---

## 9. Portability plan (phased)

### Phase 0 — Legal & fork hygiene *(0.5–1 wk)*
- Obtain GPL-3.0 legal opinion for hosted-SaaS use; document the distribution boundary.
- Fork LiteFarm into a **dedicated GPL repo**, preserve license/attribution, record provenance.
- Stand up CI + Docker Compose locally (web/api/db/redis/minio/imaginary).

### Phase 1 — Backend extraction & hardening *(2–4 wks)*
- Strip the GPL frontend from the deployable; keep **api + shared + jobs**.
- Replace deprecated deps (R2 `request`→axios; plan R3 Bull→BullMQ).
- Re-point auth (JWT/JWKS) to your IdP; add **tenant claims**.
- Introduce **multi-tenancy** (row-level + Postgres RLS recommended).
- Publish a **stable, documented REST contract** (the arm's-length boundary).

### Phase 2 — BFF / Anti-Corruption Layer *(1–2 wks)*
- Build the proprietary BFF: auth/session, tenant routing, model translation to `inflect-compliance` shapes, billing hooks.
- This is your **license firewall** and **differentiation surface**.

### Phase 3 — `inflect-compliance` frontend integration *(2–4 wks, depends on §12)*
- Wire the compliance frontend to the BFF contract only.
- Re-implement any needed geospatial/field UI in your stack (don't port GPL frontend code).
- Carry over i18n keys/strategy.

### Phase 4 — Journal & compliance domain *(3–5 wks)*
- Immutable journal, regulatory report packs, audit-ready signed exports, compliance dashboards (§8).

### Phase 5 — SaaS hardening *(2–3 wks)*
- Tenant isolation tests, rate limiting, secrets management (R11), observability (extend Sentry/Winston), billing/subscription, backups, deployment pipeline.

**Indicative total to MVP SaaS: ~11–19 weeks** for a solo founder coding with AI — dominated by multi-tenancy, the BFF, and the new compliance domain (LiteFarm gives you the hardest 60% — the domain model and backend — for free).

---

## 10. Effort & complexity (solo founder + AI)

| Workstream | Effort | Complexity | Notes |
|---|---|---|---|
| Legal/license separation | Low | ★★★★☆ | Cheap in time, high in consequence — do it right |
| Backend fork + dep modernization | Med | ★★★☆☆ | AI-friendly; deprecated-dep migration is mechanical |
| Multi-tenancy retrofit | Med-High | ★★★★☆ | The real backend risk; RLS policy coverage must be exhaustive |
| BFF / anti-corruption layer | Med | ★★★☆☆ | New code, clean to build with AI |
| inflect-compliance integration | Med | ★★★☆☆ | Depends on what it actually is (§12) |
| Journal + compliance domain | High | ★★★★☆ | Your differentiation; regulatory detail is fiddly |
| SaaS hardening (billing/obs/secrets) | Med | ★★★☆☆ | Mostly standard SaaS work |

---

## 11. Top risks & mitigations
1. **GPL contamination of frontend** → strict process/API boundary; legal opinion (§4, §6).
2. **Multi-tenancy data leakage** → Postgres RLS + tenant-isolation test suite as a release gate.
3. **Puppeteer/Chromium footprint** → isolate in jobs service; right-size containers.
4. **Upstream drift** → keep a clean fork with minimal in-tree changes; push differentiators into the BFF/extension service.
5. **Deprecated deps as supply-chain risk** → prioritize R2/R3/R5 early.
6. **Regulatory scope creep** → pick ONE jurisdiction/cert regime for MVP (e.g., EU organic or CAP), expand later.

---

## 12. Assumptions & what I need from you to finalize

To convert this from a robust generic plan into an exact build spec, confirm:
1. **What *is* `inflect-compliance`?** Your own React design system? A third-party product (e.g., Inflectra)? A Figma/spec you want implemented? This sets Phase 3 precisely.
2. **Deployment model:** SaaS-only (keeps GPL simple) vs. any on-prem/self-host ambition (changes the license calculus entirely).
3. **Target jurisdiction(s)/certification regime** for the compliance MVP (EU CAP, EU organic, GlobalG.A.P., USDA organic, etc.).
4. **Whether geospatial field mapping** is in MVP scope (drives Google Maps/terra-draw re-implementation).
5. **Green light for a from-source deep pass** (resolves all **[NEEDS SOURCE PASS]** items: SQL/query patterns, `farm_id` scoping, test coverage, secrets handling) once cloning is enabled.

---

### Sources
- LiteFarm repository — https://github.com/LiteFarmOrg/LiteFarm
- `packages/api/package.json`, `packages/webapp/package.json`, `LICENSE` (`integration` branch)
- LiteFarm engineering docs — "Tech Stack Onboarding" & "A tour of the codebase" (lite-farm.atlassian.net Confluence)
- LiteFarm project site — https://www.litefarm.org/
