# Mobile-First Kit (#19–#24) — make agri-saas truly phone-first

Field operators and farmers run their whole day from a phone, often outdoors and offline.
This kit turns agri-saas from "responsive" into genuinely mobile-first. Continues the MVP
(#1–6), Post-MVP (#7–12), and Polish (#13–18) kits.

Grounded in a mobile/PWA inspection of the repo (HEAD `174b451`). Already in place (do NOT
duplicate — EXTEND): viewport meta with `viewportFit:'cover'` (src/app/layout.tsx), a
hamburger→full-width MobileDrawer (src/components/layout/AppShell.tsx, SidebarNav.tsx),
`vaul`-backed responsive Modal/Sheet that route dialog→bottom-drawer on mobile
(src/components/ui/modal.tsx, sheet.tsx), an offline outbox + `useOfflineSync`
(src/lib/offline/*), `OfflineFieldPanel`, a web manifest + `ServiceWorkerRegistrar`, and
maplibre touch gestures (src/components/ui/map/MapCanvas.tsx).

**How to use:** run in the agri-saas session (re-paste `MEMORY-IMPORT.md` first if fresh).
Suggested order 19 → 20 → 21 → 22 → 23 → 24 (shell first; #19 also adds the mobile test
harness the others rely on). Paste `MEMORY-EXPORT.md` at each checkpoint.

---

### #19 — Mobile app shell: bottom-tab nav + safe-area + mobile test harness

```
Goal: one-thumb navigation. Field users should reach the top sections without opening a
hamburger drawer.

Build:
- Add a sticky bottom-tab bar (md:hidden) to src/components/layout/AppShell.tsx for the 5
  most-used sections (Dashboard, Tasks, Farm-Tasks, Locations/Map, Journal/Evidence). 44px+
  tap targets, icon+label, active state driven by the current route (not localStorage).
  Populate from the existing SidebarNav section config / useNavSections() (permission-gated;
  hide tabs the user can't access). Keep the hamburger MobileDrawer for the long tail.
- Honor safe-area insets (env(safe-area-inset-bottom)) so the bar clears the iOS home bar;
  add bottom padding to scroll containers so content isn't hidden behind the bar.
- Sticky, condensed top header on mobile (tenant + page title + a single primary action).
- Establish the mobile TEST HARNESS the rest of this kit needs: add Playwright device
  profiles (devices['iPhone 13'], devices['Pixel 5']) to playwright.config.ts and a
  tests/e2e/mobile/ folder with a nav smoke spec.

Reuse: AppShell, SidebarNav/useNavSections, MobileDrawer, useLocalStorage, Tailwind sm/md.
Done: bottom-tab nav works on iPhone 13 + Pixel 5 profiles; no content hidden behind bar;
permission-gated tabs; tsc 0; mobile nav e2e green. Commit feat/mobile-shell, push, MEMORY EXPORT.
```

### #20 — Responsive data surfaces: tables → cards, filters as bottom-sheet

```
Goal: kill horizontal-scroll tables on phones; make lists tappable cards.

Build:
- Add a mobileFallback?: 'card' | 'scroll' prop to src/components/ui/table/data-table.tsx.
  On <sm, 'card' renders each row as a full-width card (3–4 key fields + status pill +
  tap-through to detail); keep 'scroll' as the safe default for dense/financial tables.
  Drive the card's key fields from column meta so it stays DRY.
- Apply 'card' to the high-traffic field lists: Tasks, Farm-Tasks, Locations/Parcels,
  Inventory lots, Journal entries (via their EntityListPage/ListPageShell usage).
- Move list filters into a bottom-sheet (vaul) triggered by a "Filters" button on mobile
  instead of an inline toolbar; show active-filter chips above the list.
- Ensure ListPageShell gives a natural document scroll on mobile (it already does <md) and
  that search is reachable one-handed (sticky search field).

Reuse: DataTable (+ fillBody), ListPageShell/EntityListPage, vaul Sheet, status-pill components.
Done: no horizontal scroll on key lists at 390px; filter sheet works; tap-through to detail;
tsc 0; mobile list e2e (card render + filter) green. Commit feat/mobile-lists, push, MEMORY EXPORT.
```

### #21 — Touch-first overlays & forms (sticky save) + FAB

```
Goal: create/edit on a phone without hunting for the Save button.

Build:
- In src/components/ui/modal.tsx + sheet.tsx (mobile drawer presentation): pin the header
  (title + close) to the top and the action footer (Save/Cancel) to the bottom, with the
  body scrolling between. Forms with >5 fields must never bury Save below the fold. Respect
  keyboard insets (the footer stays visible when the on-screen keyboard opens).
- Add drag-to-dismiss + a confirm-on-dirty guard so a stray swipe doesn't discard input.
- Add a Floating Action Button (FAB) for the primary create action on key list pages
  (New Task / Start Field Operation / New Journal entry), md:hidden, above the bottom-tab bar.
- Audit high-frequency create forms (Task, Field Operation, Journal, Evidence, Inventory) to
  use <Modal> (which routes to drawer on mobile) rather than a cramped centered dialog.

Reuse: vaul Drawer (drag/snap), Modal/Sheet composition slots, existing form components.
Done: tall forms keep Save reachable with keyboard open; FAB launches primary action; dirty-
guard works; tsc 0; mobile form e2e green. Commit feat/mobile-forms, push, MEMORY EXPORT.
```

### #22 — Mobile data entry: keypads, camera capture, step-wizard, voice notes

```
Goal: fast, glove-and-sun-friendly field capture.

Build:
- Numeric ergonomics: give every numeric field inputMode="decimal" (or "numeric") so the
  phone shows a number pad (PrescriptionPanel dose, inventory qty, yield, GDD, costs);
  standardize via the existing number-stepper / @number-flow/react.
- Camera capture: add accept="image/*" capture="environment" to evidence/journal photo
  inputs (src/components/ui/file-upload.tsx, EvidenceGallery) so a tap opens the camera;
  keep the resizeImage() pipeline; show an instant local thumbnail (offline-safe).
- Reusable StepWizard (wraps Modal/Sheet) for multi-step field flows ("pick parcel → product
  → rate → confirm"), large tap targets, one decision per screen, progress dots, and
  offline-queued submit via useOfflineSync. Use it for the Field Operation create + execute.
- (Stretch) Web Speech API voice-to-text on journal note fields for hands-busy logging.

Reuse: useOfflineSync, file-upload + resizeImage, OfflineFieldPanel pattern, number-stepper.
Done: number pads appear; camera opens on photo capture; field-op wizard completes offline;
tsc 0; mobile data-entry e2e green. Commit feat/mobile-data-entry, push, MEMORY EXPORT.
```

### #23 — Map mobile-first: full-screen, GPS "locate me", bottom-sheet parcel detail

```
Goal: the map is the operator's primary screen — make it phone-native.

Build:
- Full-bleed map on mobile (account for the bottom-tab bar); large, thumb-reachable controls
  (zoom, layer toggle, draw/select) with 44px hit areas.
- Geolocation: a "locate me" button → navigator.geolocation.getCurrentPosition() centers/zooms
  to the user; render an accuracy dot. (Stretch) watchPosition() live-tracking with a
  breadcrumb for operators driving the field; permission-graceful + battery-aware.
- On parcel select (tap), show parcel detail in a bottom-sheet (vaul) — area, crop, last
  application, and the apply-rate calculator / "start operation here" action — instead of a
  detail list far below the map. Desktop keeps the side panel.
- Make the OfflineFieldPanel map full-width (today h-[300px]) on phones and selectable.

Reuse: MapCanvas (bounds/selectedIds/onSelectionChange), Sheet (bottom on mobile), geo.ts.
Done: locate-me recenters on device GPS; tap-parcel opens bottom-sheet with actions; controls
are thumb-sized; tsc 0; map mobile e2e (touch select + locate) green. Commit feat/mobile-map,
push, MEMORY EXPORT.
```

### #24 — Installable PWA, offline-first field routes, push + mobile perf budget

```
Goal: an app you install, that works in a dead-zone field, and stays fast on a mid-range phone.

Build:
- Install: add a beforeinstallprompt listener in ServiceWorkerRegistrar → a dismissible
  "Install AgriSaaS" banner on mobile (snooze 7 days in localStorage); add an iOS
  "Add to Home Screen" hint (no beforeinstallprompt on iOS).
- Background sync: upgrade public/sw.js to register a 'flush-outbox' background-sync tag on
  first send failure so queued mutations flush when the network returns without reopening the
  app; surface a "Sync now" + pending-count affordance on every offline-capable surface (reuse
  useOfflineSync), not just OfflineFieldPanel.
- Offline-first for the field routes (Map, Tasks assigned to me, Field Operation execute):
  precache the app shell + last-viewed location/parcel data so they open with no signal.
- Push notifications (Web Push) for task assignment / spray-window alerts, wired to the
  existing notification system; permission-graceful, opt-in.
- Mobile perf budget: add a Lighthouse-CI mobile run (390/414px) to .github/workflows with
  budgets (LCP, INP, TBT) and track web-vitals; fix the top regressions (code-split the map
  + terra-draw which already dynamic-import; defer heavy charts on mobile).

Reuse: ServiceWorkerRegistrar, manifest.webmanifest, outbox/useOfflineSync, notifications,
existing dynamic imports.
Done: installable on iOS+Android; queued field actions auto-sync via background sync; field
routes open offline; push arrives for an assignment; Lighthouse mobile budget enforced in CI;
tsc 0. Commit feat/mobile-pwa, push, FINAL MEMORY EXPORT.
```
