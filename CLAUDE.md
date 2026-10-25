# CLAUDE.md

Guidance for Claude Code sessions in this repository.

## What this is

A prototype that anchors audit-report PDFs on a public testnet (Ethereum
Sepolia), links each PDF to the block that recorded it, chains reissued
versions so any copy resolves to the latest, and lets outside parties verify a
copy in their own browser. **Read `docs/ROADMAP.md` before starting work**: it
holds the phases, each phase's exit gate and hardening list, and the prompt
that starts each phase. The decisions behind the design are in `docs/adr/`.

Phase 0 (the Next.js scaffold rendering Inflect's UI primitives in its own
theme) and Phase 1 (the `AuditReportRegistry` contract and the viem chain
adapter, tested on Anvil) are done. The Sepolia deployment waits on funded keys
(#4). Phase 2a (PDF parsing, the opinion locator and the commitments, with no
database or UI) is done; 2b adds storage, sign-in and the confirmation screen.

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

# Contracts (Foundry v1.8.6 on PATH; forge-std is a submodule: git submodule update --init)
(cd contracts && forge build)                            # compile
(cd contracts && FORGE_SNAPSHOT_CHECK=true forge test)   # unit, fuzz, invariant and gas tests
(cd contracts && forge fmt --check && forge lint --deny notes)
npm run contracts:artifact     # regenerate src/lib/chain/registry-artifact.ts after a contract change
npm run test:integration       # chain adapter against a throwaway Anvil node
npx tsx scripts/deploy-registry.ts <sepolia|local>       # deploy; reads keys from env only

# PDFs
npm run test:pdf               # parser, golden hashes, fuzzing (forks the real parser)
npm run test:golden            # golden hashes only; CI also runs this on Windows
npm run fixtures:pdf           # regenerate tests/fixtures/pdf/*.pdf; add `-- --check` to compare
node scripts/fetch-public-corpus.mjs && npx tsx scripts/measure-opinion-locator.ts   # real-report hit rate
```

Locally, Playwright needs the browser of its own version:
`npx playwright install chromium`.

## The registry and the chain adapter

- **`contracts/src/AuditReportRegistry.sol` is immutable once deployed.** A
  change to it means a new deployment and a new `deployments/<network>.json`;
  code refuses a deployment whose bytecode hash is not the current build's
  (`DEPLOYMENT_STALE`). After editing the contract, run `npm run
  contracts:artifact` and commit the regenerated artifact; CI fails if the two
  disagree.
- **Gas ceilings are tests.** `contracts/test/AuditReportRegistry.gas.t.sol`
  caps each write, and `contracts/snapshots/` pins the exact figures. A change
  that moves them updates the snapshot in the same pull request
  (`forge test` rewrites it; CI runs with `FORGE_SNAPSHOT_CHECK=true`).
- **All chain access goes through `src/lib/chain/`.** `createChainAdapter`
  checks the chain id and the code at the registry address, then simulates,
  before every write, so a refusal is a named `RegistryRevertError` and nothing
  is broadcast. A returned `txHash` is not an anchor: call `waitFinal`.
- **Integration tests start their own Anvil** with `--slots-in-an-epoch 1`, so
  `finalized` trails `latest` by two blocks; mine blocks to reach finality.

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

## PDFs, the opinion and the commitments

- **Never parse an untrusted PDF in the server process.** Call
  `parsePdf` (`src/lib/pdf/parse.ts`), which forks `parse-child.mjs` with a
  heap cap and a timeout and returns a parsed PDF or a named refusal.
- **What a commitment means is versioned.** `normaliseText`, `joinLines`,
  `dropRunningLines` and the commitment encodings are normaliser v1 and
  manifest schema 1. A change that moves any value in
  `tests/pdf/golden.test.ts` is a new version (and a reader for the old one),
  never an edit; regenerating a fixture legitimately moves only its `docHash`.
- **The locator answers FOUND only when it is sure.** Every doubt is a
  `NOT_FOUND` with a reason, and a person types the opinion instead. Do not
  loosen a heading rule to raise the hit rate without a corpus case that shows
  the new rule cannot pick a wrong passage.
- **Fixtures are synthetic and reproducible.** `tests/fixtures/pdf/reports.ts`
  holds their text; CI regenerates the PDFs and fails on any byte difference.
  Real reports are listed by URL and SHA-256 in
  `tests/fixtures/public-corpus.json` and downloaded into `.cache/`, never
  committed.

## Conventions

- Dependencies are exact versions (`.npmrc` has `save-exact=true`).
- UI strings go through next-intl. `messages/en.json` and `messages/bg.json`
  must carry the same keys; a test enforces it, and it also refuses an app key
  that collides with a vendored one.
- Secrets never enter the repository. Only `.env.example` is committed, with
  names and no values.
- Use the vendored primitives rather than hand-rolling a button, input, modal
  or badge.
