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
(#4). Phase 2 (PDF parsing, the opinion locator, the commitments, encrypted
storage, sign-in and the confirmation screen) is done. Phase 3 (the write
ladder, four-eyes approval, the ChainWrite journal and its worker, new
versions, the audit log, the balance alert, stamping, the distribution copy
and the certificate for anchor-only reports) is done and tested on Anvil; its
Sepolia run waits on #4.

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

# Database (Postgres 16: `docker compose up -d`, or any local server; Prisma 7 does not read .env)
npm run db:migrate             # create and apply a migration in development
npm run db:seed                # the firm and two users, from SEED_* in the environment
npm run test:db                # intake and approval use cases against TEST_DATABASE_URL (name must end in _test)
npm run test:anchoring         # the worker against TEST_DATABASE_URL and a throwaway Anvil node
npm run worker                 # the anchoring worker; add `-- --once` for one pass

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

## Sign-in, storage and the database

- **Every page and route checks the user itself.** Pages call
  `requireUser()` (`src/lib/page-auth.ts`): Next.js renders a layout and its
  page in parallel, so a layout's check does not protect the page. Route
  handlers wrap in `handler()` (`src/lib/http.ts`), which also refuses a
  cross-origin write and turns an `IntakeError` into a status and a code.
- **Use cases scope every query to the caller's firm** (`orgId`) and check the
  role. A record from another firm is `NOT_FOUND`, never `FORBIDDEN`.
- **Confidential data is sealed, never stored in clear**: use `seal`/`open`
  from `src/lib/sealed.ts` with a context naming the row and field, and
  `storeFile`/`readStoredFile` for PDFs. Never log a file, an opinion or a
  manifest.
- **Never run `prisma migrate reset` or anything that drops data** without the
  owner's explicit consent. Tests use `migrate deploy` on a `_test` database.

## Anchoring: the journal and the worker

- **Only the worker signs or sends** (`src/lib/anchoring/worker.ts`, run by
  `scripts/worker.ts`). The app approves, which writes the journal's INTENT
  row in the same transaction as the approval; it never talks to a chain
  with a key. Only `scripts/worker.ts` reads `ISSUER_PRIVATE_KEY`, and
  `tests/unit/key-boundary.test.ts` refuses the name anywhere under `src/`.
- **Journal before the bytes leave.** The worker signs, writes the nonce and
  hash to the row, then sends. Every transition is one transaction,
  conditional on the row being as it was read, and writes its audit event.
- **Unknown is INDETERMINATE, and INDETERMINATE is never resent.** It is
  settled only by reading the chain: receipts for every hash, the node's
  pool, the issuer's finalized nonce, the record for the document. While one
  is unsettled no new LIVE write starts for that issuer key (#78).
- **A row holds its nonce only while its transaction may land or once its own
  transaction used it**; otherwise clear the nonce. A partial unique index
  allows one row per (chain, issuer, nonce).
- **Do not add a path to APPROVED, ANCHORED or FINAL** other than
  `approveVersion` and the worker's transitions. CHECK constraints hold
  four-eyes and "approved means an approver is recorded"; a partial unique
  index allows one live write per version and kind.
- **The audit log is append-only**: write through `appendAuditEvent` inside
  the transaction that makes the change, with ids, hashes and codes only.
  `verifyAuditChain` re-derives every hash.
- **Worker tests use fault seams** (`faults.afterBuild`, `beforeSend`,
  `afterSend`) and an injected clock. A throw from a seam is a crash: the row
  keeps its lease until it runs out.
- **Never rewrite an anchored file.** A distribution copy is the original plus
  an incremental update (`stampPdf`, `src/lib/stamp.ts`), checked by
  `checkStampedCopy` before it is stored or sent. A signed or edit-protected
  version (`anchorOnly`) is never stamped; it gets a certificate
  (`src/lib/certificate.ts`). Stamping and certificates are deterministic.
- **Stamps are read with `readStamp`** (`src/lib/stamp-fields.ts`, no Node
  imports, so the browser verifier can share it). A stamp is a claim; only the
  chain says whether the record it names is this file.
- **The worker runs from the app's directory** (the PDF parser is found from
  there) and needs `FILE_*` and `APP_PUBLIC_URL` besides its chain settings.

## Conventions

- Dependencies are exact versions (`.npmrc` has `save-exact=true`).
- UI strings go through next-intl. `messages/en.json` and `messages/bg.json`
  must carry the same keys; a test enforces it, and it also refuses an app key
  that collides with a vendored one.
- Secrets never enter the repository. Only `.env.example` is committed, with
  names and no values.
- Use the vendored primitives rather than hand-rolling a button, input, modal
  or badge.
