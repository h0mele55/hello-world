# CLAUDE.md

Guidance for Claude Code sessions in this repository.

## What this is

A prototype that anchors audit-report PDFs on a public testnet (Ethereum
Sepolia), links each PDF to the block that recorded it, chains reissued
versions so any copy resolves to the latest, and lets outside parties verify a
copy in their own browser. **Read `docs/ROADMAP.md` before starting work**: it
holds the phases, each phase's exit gate and hardening list, and the prompt
that starts each phase. The decisions behind the design are in `docs/adr/`.

Phase 0 (this scaffold) is done: a Next.js app that renders Inflect's UI
primitives in its own theme. Nothing touches a chain or a PDF yet.

## Rules every phase keeps

These bind every change. A pull request that breaks one is wrong even if CI is
green.

1. **Nothing confidential goes on chain.** Only 32-byte commitments and
   pseudonymous family ids; never a client name, opinion type or report text.
2. **A transaction hash is not an anchor.** A record counts as anchored only
   once its block is `finalized`.
3. **Every chain write goes through the journal.** The INTENT row exists before
   broadcast. An unknown outcome is INDETERMINATE and is reconciled by reading
   the chain, never by resending blindly.
4. **Only an exact-file match is "Authentic".** Every other verdict says what
   it proves and what it does not.
5. **The verifier never uploads the PDF** and must work with the app's server
   down.
6. **A person confirms the opinion before anything is anchored**, and the
   preparer cannot approve their own anchor.
7. **Fail closed, with a named reason.** An unparseable PDF, an unreadable
   chain, two RPC endpoints that disagree, or a family whose latest version
   cannot be determined is refused, never guessed.
8. **Vendored Inflect code is never edited in place.** Change it upstream, then
   re-sync.
9. **Testnet anchors are prototype evidence.** Nothing in the UI or the docs
   calls them legally binding.

## Commands

```bash
npm run dev            # Next.js dev server
npm run build          # production build (also typechecks)
npm run lint           # ESLint (flat config)
npm run typecheck      # tsc --noEmit
npm test               # Vitest unit tests (tests/unit)
npm run test:e2e       # Playwright against `next start` on port 3100; build first
npm run vendor:check   # vendored Inflect UI matches its manifest (offline, fast)
npm run vendor:sync    # re-vendor at the pinned commit; add `-- --ref <sha>` to move the pin
node scripts/sync-inflect-ui.mjs --check   # re-derive the vendored tree from upstream
```

## The vendored Inflect UI

`@inflect/ui` is source-only, private and BUSL-1.1, and npm cannot install a
subdirectory of a git repository, so `vendor/inflect-ui/` holds a copy pinned
to one inflect-compliance commit.

- **Import it as `@inflect/ui/...`**, e.g.
  `@inflect/ui/components/ui/button`. `tsconfig.json` maps that alias to
  `vendor/inflect-ui/src/*`, the same mapping inflect-compliance uses. ESLint
  refuses a relative import into `vendor/inflect-ui/src`.
- **Never edit `vendor/inflect-ui/`.** CI re-hashes it against
  `vendor/inflect-ui/manifest.json` and also re-derives it from upstream.
- **To use another component**, add its upstream path to `entries` in
  `vendor/inflect-ui.config.json` and run `npm run vendor:sync`. The script
  copies the import closure, rewrites `@/components/ui/*` and `@/lib/hooks/*`
  to `@inflect/ui/...`, and refuses any other `@/` import or a bare import that
  is not a runtime dependency in `package.json`. Message keys the components
  read are listed under `messages` in the same config.
- **Moving the pin** (`npm run vendor:sync -- --ref <sha>`) is a pull request
  of its own.
- **Tokens**: `src/styles/theme.css` overrides all 47 names in
  `vendor/inflect-ui/tokens.contract.css`, light and dark. Three of them are
  box-shadow values, not colours: `--btn-still-lift`, `--btn-still-press`,
  `--ctrl-edge-focus`. `tests/unit/theme.test.ts` checks coverage, shadow
  types and WCAG contrast.
- **Host recipes**: some components name CSS classes the package does not ship
  (`glass-card`, `surface-popup-texture`, `data-table`, `animate-fadeIn`).
  `src/app/globals.css` defines them. The sync records the list in the
  manifest (`hostClassesReferenced`), and `tests/unit/host-recipes.test.ts`
  fails if one is missing.
- **Tailwind**: `tailwind.config.js` maps the tokens to utilities
  (`bg-bg-default`, `text-content-muted`, `gap-tight`, …), and `globals.css`
  carries `@source` for the vendored tree. Without that line the components
  render unstyled on a green build; `tests/e2e/kitchen-sink.spec.ts` is the
  check.
- **DataTable is not vendored**: upstream classifies it MIXED. Use
  `@tanstack/react-table` inside the vendored `Card`.

## Conventions

- Dependencies are exact versions (`.npmrc` has `save-exact=true`).
- UI strings go through next-intl. `messages/en.json` and `messages/bg.json`
  must carry the same keys; a test enforces it, and it also refuses an app key
  that collides with a vendored one.
- Secrets never enter the repository. Only `.env.example` is committed, with
  names and no values.
- Use the vendored primitives rather than hand-rolling a button, input, modal
  or badge.
