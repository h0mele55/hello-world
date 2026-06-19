# Delight Kit (#25–#30) — the joy layer that makes farmers love the app

The arc so far: MVP (#1–6) → Post-MVP (#7–12) → Polish/Harden (#13–18) → Mobile-first
(#19–24). This kit is **delight** — the small, human, surprising touches that turn a
correct tool into one people *want* to open. Built on existing IC assets: `src/lib/
celebrations.ts`, `sonner` toasts, `html-to-image` + `pdfkit`, `src/lib/onboarding-steps.ts`,
the design tokens, and `next-intl`.

GUARDRAILS TO RESPECT (don't fight them): the **no-decorative-emoji-in-messages** guard
(keep i18n strings emoji-free — put any emoji/icon in components, not message catalogs), the
**animation-vocabulary / animation-language-lock** guards (use the sanctioned motion tokens),
and `prefers-reduced-motion` (every animation needs a reduced-motion path). Delight must stay
fast on a mid-range phone and never block a field action.

How to use: run in the agri-saas session (re-paste `MEMORY-IMPORT.md` if fresh). Independent;
any order. Paste `MEMORY-EXPORT.md` at each checkpoint.

---

### #25 — Micro-interactions & motion polish

```
Goal: every tap feels alive and responsive — without slowing the field user down.

Build:
- A small motion layer using the sanctioned animation tokens (respect animation-vocabulary /
  animation-language-lock guards): press/active states on buttons & cards, smooth
  skeleton→content cross-fades, list add/remove/reorder transitions, and map fly-to easing
  when selecting a parcel or hitting "locate me".
- Optimistic feedback everywhere a mutation runs (the SWR optimistic hooks already exist):
  instant UI state + a subtle inline spinner, never a blocking modal.
- Mobile haptics: light vibration (navigator.vibrate, capability-gated) on key field actions
  (mark parcel done, capture photo, submit offline).
- A polished toast vocabulary via sonner: success/error states + an undo affordance on destructive actions
  ("Operation marked done — Undo").
- Hard rule: every animation has a prefers-reduced-motion fallback; nothing janks at 60fps on
  a Pixel 5; no layout shift.

Reuse: sonner, existing SWR optimistic mutations, design/motion tokens, useReducedMotion.
Done: interactions feel instant; undo works on destructive toasts; reduced-motion verified;
no CLS regressions; tsc 0; animation guards green. Commit feat/delight-motion, push, MEMORY EXPORT.
```

### #26 — Celebrations & milestones

```
Goal: mark the moments that matter so progress feels rewarding.

Build (extend src/lib/celebrations.ts):
- Tasteful, infrequent celebrations on meaningful events: first field mapped, a spray job
  100% complete across all parcels, first harvest recorded, a season closed, a certification
  inspection passed, 100% SOP acknowledgement on the team. Confetti/burst is brief, dismissible,
  reduced-motion-safe, and never fires on routine saves (celebrate outcomes, not keystrokes).
- A lightweight milestones/achievements surface on the dashboard ("Mapped 10 fields",
  "First certified season") — data-derived, no new heavy schema (compute from existing rows).
- Optional streaks ("logged field work 7 days running") to nudge daily journaling — opt-in,
  never guilt-trippy.

Reuse: celebrations.ts, sonner, dashboard widgets (react-grid-layout), audit/event data.
Done: each milestone fires once, feels earned, respects reduced-motion; achievements render on
the dashboard; tsc 0. Commit feat/delight-celebrations, push, MEMORY EXPORT.
```

### #27 — Empty states, first-run & "try it" delight

```
Goal: a new farmer's first five minutes feel guided and effortless, never a blank slate.

Build:
- Friendly, illustrated empty states for every key surface (Locations, Journal, Inventory,
  Tasks, Certification) — each with a one-tap primary action and a one-line "why this matters".
- A guided first-run flow ("Map your first field → log your first job") layered on
  src/lib/onboarding-steps.ts, with a progress ring that quietly disappears once the farm is set up.
- A "try it with sample data" mode: seed a demo field + parcels + a sample spray job the user
  can play with, then clear with one tap (reuse the demo-seed pipeline; tenant-scoped + reversible).
- Contextual coach-marks (first time only) on the map and the field-operation wizard.

Reuse: onboarding-steps.ts, demo seed scripts, empty-state component pattern, EntityListPage.
Done: no raw blank screens; first-run flow completes; sample-data toggles cleanly; coach-marks
show once; tsc 0; a11y on empty states. Commit feat/delight-onboarding, push, MEMORY EXPORT.
```

### #28 — Smart defaults & "it just knows"

```
Goal: the app anticipates the next action so field entry is near-zero-typing.

Build:
- Recall last-used values: product + dose per crop/field, default unit, last location; "Repeat
  last job" on a field; prefill spray dose from the variety/crop defaults already in the catalog.
- GPS-aware: on the mobile map, auto-suggest the nearest field/parcel to the user's location as
  the default selection (reuse the locate-me geolocation from #23).
- Context-aware suggestions: surface today's good spray window on the relevant fields (reuse the
  agro-signals/weather layer), and suggest the next task from the crop plan.
- Keep it suggestions, not silent automation — always editable, one tap to accept; learn from
  per-user history (no new ML, just recency/frequency + existing data).

Reuse: agro-signals/weather, crop-plan tasks, catalog defaults, geolocation, SWR caches.
Done: "repeat last job" prefills correctly; nearest-field auto-selected; spray-window suggestion
appears on the right fields; everything editable; tsc 0; tests for the recall logic. Commit
feat/delight-smart-defaults, push, MEMORY EXPORT.
```

### #29 — Personality, warmth & the weather-aware home

```
Goal: a home screen that greets the farmer like a helpful colleague, in their language.

Build:
- A weather-aware, time-aware home header: "Good morning. 3 fields ready to spray — wind 8 km/h,
  good window until noon." Pulls from the weather/agro layer + today's tasks; degrades gracefully
  with no data.
- Warm, plain microcopy pass across primary surfaces (buttons, confirmations, errors) — helpful
  and human, NOT cute; keep i18n strings emoji-free (no-decorative-emoji guard) and give Bulgarian
  the same warmth (not a literal translation). 
- A high-contrast "sunlight" theme toggle for outdoor readability, alongside dark mode; remember
  the choice per user.
- Small personal touches: greet by name, show the user's avatar/initials, seasonal framing
  (spring/harvest) on the dashboard.

Reuse: next-intl (en + bg), weather/agro data, design tokens/theme system, account/avatar.
Done: home greeting reflects real weather + tasks; sunlight theme is readable in bright light;
bg copy reviewed; messages stay emoji-free; tsc 0; i18n parity guard green. Commit
feat/delight-personality, push, MEMORY EXPORT.
```

### #30 — Shareable wins & sensory confirmation

```
Goal: give farmers something satisfying to keep and show off — and make field actions feel solid.

Build:
- Shareable summary cards rendered to an image (html-to-image): a "Season recap" (yields, area,
  cost/ha, top fields), a "Field report", and a spray-job completion card — one tap to save/share.
- A beautiful printable/PDF "Year on the farm" report (pdfkit) — the certification + yield +
  activity story for the season, suitable for a bank, buyer, or pride.
- QR codes for parcels and inventory lots: print/stick in the field or on a bin; scanning opens
  the right detail page (deep link), great for traceability and quick mobile access.
- Sensory confirmation for field actions: a short success sound + haptic (both capability-gated
  and user-toggleable) when an operation/parcel is marked done offline, so operators get feedback
  even with gloves and no glance.

Reuse: html-to-image, pdfkit, reports machinery, deep-link routing, navigator.vibrate.
Done: recap/field/job cards export as crisp images; the season PDF generates; parcel/lot QR codes
resolve to the right page; success sound+haptic toggle works; tsc 0. Commit feat/delight-shareables,
push, FINAL MEMORY EXPORT.
```
