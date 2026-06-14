# MEMORY IMPORT — paste once at the top of the agri-saas session

Paste the block below into a fresh Claude Code session scoped to the `agri-saas` repo,
before running any BUILD PROMPT (see `BUILD-KIT.md`).

```
You are building an agriculture-management SaaS ON TOP OF the inflect-compliance
(IC) platform. This repo (agri-saas) is the product. You have NO prior memory; load
it now and DO NOT write code until you've confirmed the summary at the end.

1) Read these (public, raw):
   https://raw.githubusercontent.com/h0mele55/hello-world/claude/lucid-mendel-deft48/ag-saas/PLAN.md
   https://raw.githubusercontent.com/h0mele55/hello-world/claude/lucid-mendel-deft48/ag-saas/REPOS.md
   https://raw.githubusercontent.com/h0mele55/hello-world/claude/lucid-mendel-deft48/ag-saas/BUILD-KIT.md
   https://raw.githubusercontent.com/h0mele55/hello-world/claude/lucid-mendel-deft48/ag-saas/feature-1-spray-map/README.md
   If ag-saas/MEMORY.md exists in THIS repo, read it too — it is the latest status.

2) Verify repo state:
   - Confirm the IC platform is present (prisma/schema/, src/app-layer/, package.json
     with "next"). If the repo is bare, seed it: add upstream
     https://github.com/inflect-compliance/inflect-compliance.git , fetch, set main to
     upstream/main, push -f origin main.
   - Confirm Feature 1 is applied (prisma/schema/agriculture.prisma, src/lib/spatial/
     parse.ts, src/lib/db/geo.ts, the ag migration). If missing, apply
     feature-1-spray-map/feature1.patch (git am, or git apply --3way).

3) Stand up the validated dev DB (Docker registry may be blocked — use NATIVE PostGIS,
   recipe in feature-1-spray-map/README.md): apt-get install postgresql-16-postgis-3,
   run the local 16/main cluster, create db inflect_compliance + role app_user (grants
   per prisma/init-roles.sh) + CREATE EXTENSION postgis; .env DATABASE_URL/
   DIRECT_DATABASE_URL → 127.0.0.1:5432; npm ci.
   GOTCHA: Prisma 7 does NOT auto-load .env for the CLI — prefix with
   `set -a && . ./.env && set +a`. Then: prisma migrate deploy; prisma generate;
   jest tests/unit/spatial-parse.test.ts (14 pass); tsc --noEmit (0 errors).

4) Internalize these NON-NEGOTIABLE house rules:
   - Every new tenant-scoped table (tenantId column) needs the RLS trio
     (tenant_isolation + tenant_isolation_insert + superuser_bypass + FORCE) in its
     migration, or the rls-coverage guardrail fails. Global catalogs (no tenantId) get none.
   - Reuse IC patterns; the Assets module (src/app-layer/usecases/asset.ts,
     src/app/api/t/[tenantSlug]/assets/, src/app/t/[tenantSlug]/(app)/assets/) is the
     end-to-end template (usecase→repository→Zod→DTO→route→ListPageShell/EntityDetailLayout).
   - Client data via useTenantSWR/useTenantMutation + makeResource() in src/lib/swr-keys.ts.
   - Emit logEvent (src/app-layer/events/audit.ts) on every state change; cover with the
     audit-event guardrail.
   - All ST_* SQL stays in src/lib/db/geo.ts. shpjs needs globalThis.self=globalThis
     server-side (see parse.ts). Prisma `migrate dev --create-only` then hand-edit to
     drop unrelated drift + add RLS, then `migrate deploy`.
   - LICENSE HYGIENE (REPOS.md): never copy GPL/AGPL code (farmOS, LiteFarm, ERPNext,
     Ekylibre, Qrop, Nekazari-core); reimplement concepts. Port only MIT/Apache/BSD/CC0
     (InvenTree, HortusFox, Permastead, OFBiz, OpenFarm-data) with attribution in
     THIRD_PARTY_NOTICES.md.

5) STOP and reply with: (a) a 6-line summary of the product + chassis + this session's
   scope (Phase 0 + MVP core), (b) repo + Feature-1 + dev-DB status (pass/fail per check),
   (c) the ordered list of the 6 build prompts you expect. Then wait for BUILD PROMPT 1.
```
