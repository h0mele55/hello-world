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
Sepolia run waits on #4. Phase 4 (the shared verification code, `/verify`,
`/r/<familyId>/latest`, the single-file verifier and CLI, the tamper suite,
CSP and rate limits) is done on Anvil, which completes the prototype; its
Sepolia run waits on #4 too. Phase 5, the issuer console, is done on Anvil:
roles, two-step sign-in and rate limits (5a), the client list, version
timeline and dashboard (5b), revocation (5c), the audit-log viewer, nightly
chain check and backups (5d), and recipients with the two-person exit gate
(5e). `docs/operations.md` says what runs besides the app. Phase 6 is under
way: `docs/threat-model.md` names each threat with the test that proves its
mitigation, or the issue that tracks it, and `docs/runbooks/` says what to do
when a key, an owner, an endpoint or the database must change. The issuer key
can live in Cloud KMS (6b), the production candidates are measured for the
owner's choice (6c, `docs/decision-production-chain.md`), and revocation is
delayed so the owner can cancel a stolen key's (6d, #95), the registry
watch reports any write by the firm's keys that the journal did not make (6e,
#93), recipients are told of a withdrawal (6f, #96), the worker settles a
row only on what two endpoints agree on (6g, #92), and the audit log's head is
written on chain each night (6h, #94).

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
npm run test:integration       # chain adapter and verifier against throwaway Anvil nodes
npx tsx scripts/deploy-registry.ts <network>             # deploy (sepolia, local, base-sepolia, …); production networks refused until #63; REVOCATION_DELAY_HOURS (default 24, local 0)
npx tsx scripts/measure-chain-costs.ts                   # today's cost per report and finality lag on the production candidates
npx tsx scripts/owner-call.ts <sepolia|local> <add-issuer|remove-issuer|cancel-revocation|void-audit-head|transfer-owner|accept-owner> [address|recordId|index]   # prints the owner's transaction; sends nothing
npx tsx scripts/kms-address.ts <KMS key version name>     # the address of a Cloud KMS issuer key, to register it

# Database (Postgres 16: `docker compose up -d`, or any local server; Prisma 7 does not read .env)
npm run db:migrate             # create and apply a migration in development
npm run db:seed                # the firm and its users, from SEED_* in the environment
npm run test:db                # intake and approval use cases against TEST_DATABASE_URL (name must end in _test)
npm run test:anchoring         # the worker against TEST_DATABASE_URL and a throwaway Anvil node
npm run worker                 # the anchoring worker; add `-- --once` for one pass
npm run audit:check            # the nightly audit-chain check, held to its heads on chain; queues the next head; exit 1 on a break
npm run watch:registry         # every 10 min: report chain writes by the firm's keys the journal did not make; exit 1 while one is unreviewed
npm run mailer                 # sends the recipients' notices; add `-- --once` for one pass (SMTP_URL, MAIL_FROM)
scripts/backup.sh              # database dump + encrypted store copy (docs/operations.md)
npm run test:backup            # back up, restore into <db>_restore_test, check the copy

# The verifier
npm run build:verifier         # dist/verifier.html and dist/verify-report.mjs, for VERIFY_NETWORK (or ANCHOR_NETWORK)
node bin/verify-report.mjs report.pdf [--deployment <file> --rpc <url> --rpc <url>]   # verdict as JSON
npm run test:tamper            # the tamper suite on Anvil, through verify-core and the CLI; needs qpdf and Chromium

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
- **Revocation is delayed (#95).** An issuer key's `revoke` only asks: the
  revocation takes effect `revocationDelay` seconds later (set at deployment,
  in storage so every deployment has the same bytecode; at most 30 days, and
  the deploy script refuses less than an hour off a local chain). Until then
  only the owner's `cancelRevocation` undoes it, never an issuer key; once in
  effect it is terminal. `getRecord` computes `revoked` from the block's time,
  so whether a record is revoked depends on the block read: decide it at the
  finalized block (rule 2). A record holds one revocation, pending or in
  effect; `revokeReason` is non-zero for both, and `revokeEffectiveAt` says
  when.
- **Each firm's audit-log heads live in the registry (#94).** An issuer key's
  `recordAuditHead(head)` appends the hash of the firm's latest audit event,
  and nothing else; only the owner's `voidAuditHead` sets one aside, for a
  head a stolen key wrote. Heads are never removed: the nightly check holds
  the log to every head not voided.
- **Gas ceilings are tests.** `contracts/test/AuditReportRegistry.gas.t.sol`
  caps each write, and `contracts/snapshots/` pins the exact figures. A change
  that moves them updates the snapshot in the same pull request
  (`forge test` rewrites it; CI runs with `FORGE_SNAPSHOT_CHECK=true`).
- **Networks are one table**, `NETWORKS` in `src/lib/chain/networks.ts`: Sepolia,
  local, and the production candidates (mainnet, Base, OP Mainnet, Arbitrum One)
  with their Sepolia testnets. Each has `<NETWORK>_RPC_URL`, its own
  `deployments/<network>.json`, an explorer and a readable name. Which one is
  production is the owner's decision (`docs/decision-production-chain.md`);
  until then the deploy script refuses `PRODUCTION_NETWORKS`.
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
  with a key. Only `scripts/issuer-env.ts` (used by the worker and the
  operator tools) reads `ISSUER_PRIVATE_KEY`, and
  `tests/unit/key-boundary.test.ts` refuses the name anywhere under `src/`.
- **With `SIGNER=kms` the key never leaves Cloud KMS**
  (`src/lib/chain/kms-account.ts`): a viem account that sends KMS the keccak
  digest, checks every CRC32C integrity field, reads the DER signature
  strictly, normalises it to low s and recovers the parity against the key's
  own address. Any doubt is a named `KmsSignerError` and nothing is sent. Tests
  use `tests/helpers/fake-kms.ts`; the ceremony for a real key is
  `docs/runbooks/kms-key.md`.
- **Journal before the bytes leave.** The worker signs, writes the nonce and
  hash to the row, then sends. Every transition is one transaction,
  conditional on the row being as it was read, and writes its audit event.
- **A row is settled only on what two endpoints agree on** (#92). The worker
  sends through `<NETWORK>_RPC_URL` and also reads `<NETWORK>_RPC_URL_2`, from
  another provider (`secondRpcUrlFor` refuses a missing one or one on the same
  host). Every read that settles what happened on chain (a write FINAL,
  reverted or linked; a revocation SCHEDULED, REVOKED or CANCELLED; a nonce
  used by another transaction) goes through `agree` (both answers identical,
  or `RPC_DISAGREE`) at `agreedFinalized` (the lower of the two finalized
  blocks, whose hash both must give). A disagreement leaves the row as it was,
  frees its lease so the next pass compares again, and sets
  `IssuerKeyStatus.rpcDisagreedAt` for the console's banner. A refusal before
  sending rests on the first endpoint: it sends nothing and returns the
  approval. A new settling read that skips `agree` reopens T-W5.
- **Unknown is INDETERMINATE, and INDETERMINATE is never resent.** It is
  settled only by reading the chain: receipts for every hash, the node's
  pool, the issuer's finalized nonce, the record for the document. While one
  is unsettled no new LIVE write starts for that issuer key. When it cannot be
  settled (its transaction unknown, its nonce unused), an approver runs
  `scripts/settle-write.ts`, which uses the nonce with a no-op transfer; the
  worker then reads the outcome.
- **A row holds its nonce only while its transaction may land or once its own
  transaction used it**; otherwise clear the nonce. A partial unique index
  allows one row per (chain, issuer, nonce).
- **Do not add a path to APPROVED, ANCHORED, REVOKED or FINAL** other than
  `approveVersion`, `approveRevocation` and the worker's transitions; nor to
  SCHEDULED or CANCELLED, which only the worker sets, from the chain. CHECK
  constraints hold four-eyes and "approved means an approver is recorded";
  partial unique indexes allow one live ANCHOR and ANCHOR_COPY per version and
  one REVOKE in flight per version (a cancelled revocation leaves its REVOKE
  FINAL, and the firm may ask again).
- **Revocation** (`src/lib/anchoring/revocation.ts`): an ADMIN asks, typing
  the engagement's reference, with a reason and a sealed note; an APPROVER who
  is someone else approves, which writes the REVOKE row in the same
  transaction. The worker asks the registry to revoke the original's record
  with the reason's number (`REVOCATION_CODES`, fixed: verifiers read them from
  records already on chain). Once that block is final the revocation is
  SCHEDULED with its `effectiveAt`; each pass then reads every scheduled one at
  the finalized block (`settleScheduledRevocations`): in effect, the version
  and the revocation are REVOKED (`revokedAt` is the time it took effect);
  gone, the owner cancelled it, the revocation is CANCELLED and the version
  stands. A failed or simulated REVOKE returns the request for approval; a
  record whose revocation, pending or in effect, has the same reason is
  linked, never asked twice, and one with another reason is a named refusal
  for a person. Revoking the original is enough: the verifier calls a copy
  revoked (or being withdrawn) when its original is. No copy is stamped or
  certified while a revocation is open.
- **An `AUDIT_HEAD` journal row writes the firm's audit-log head (#94)**, not
  a report: it has no `reportVersionId` (a CHECK holds both ways), only the
  nightly check queues one (one in flight per firm, chain and registry), and
  the worker sends it without an approval and settles it on its own
  `AuditHeadRecorded` event. Its events are `audit_head.*`, never `anchor.*`,
  so no count of anchors includes them and the check can tell them from new
  activity. Every journal row names its firm (`orgId`).
- **The audit log is append-only**: write through `appendAuditEvent` inside
  the transaction that makes the change, with ids, hashes and codes only.
  `verifyAuditChain` re-derives every hash.
- **Lock a firm's row `FOR NO KEY UPDATE`, never `FOR UPDATE`.** Every audited
  write holds the firm's audit lock and then inserts rows whose foreign key
  takes a key-share lock on that row; `FOR UPDATE` blocks that, and a
  transaction holding it that then asks for the audit lock deadlocks
  (`tests/db/anchoring.test.ts` reproduces it).
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
  A failed pass (an endpoint or the database out) is tried again after the
  interval; after 20 in a row the process exits 1 for its supervisor to
  restart. The mailer does the same.
- **Rows belong to the key that was current when they were approved**, so a
  rotation drains the old key before switching (`docs/runbooks/key-rotation.md`,
  rehearsed in `tests/anchoring/worker.test.ts`). Certificates are made for an
  anchor-only version whichever key anchored it: a certificate signs nothing.
- **The registry watch** (`src/lib/anchoring/registry-watch.ts`, run by
  `scripts/watch-registry.ts`) reads every `Anchored`, `RevocationRequested`
  and `AuditHeadRecorded` event by the firm's issuer keys up to the finalized
  block and matches it to the journal **by transaction hash**, current or
  replaced. This works only because every hash is journalled before it is sent
  (rule 3): a new path that sends a registry write without a journal row will
  be reported as a stolen key. Findings (`UnjournaledWrite`) and the checkpoint
  are written in one transaction per range; only an ADMIN marks a finding
  reviewed (`reviewUnjournaledWrite`).
- **The owner's acts go through `scripts/owner-call.ts`**, which checks the
  chain and the registry, simulates, and prints the transaction for the owner
  (the deployer key, later a Safe) to execute. It sends only an issuer change
  or a cancellation, only with `--send` and `OWNER_PRIVATE_KEY`, and never an
  ownership move. A revocation the firm did not ask for is
  `docs/runbooks/stolen-issuer-key.md`.

## The verifier

- **Verification code lives in `src/lib/verify-core/`** and runs unchanged in
  the browser and in Node: no server imports, only `viem`, `zod` and plain
  modules. `tests/unit/verify-core-imports.test.ts` walks its imports. The
  server's isolated parser uses its line, page and metadata readers, so both
  read the same text from the same file.
- **`/verify` decides in the browser** (rule 5). The server hands the page
  only public settings (`verifierSetupFromEnv`, `src/lib/verify-setup.ts`):
  the registry, its bytecode hash, the issuer names from the deployment record
  and `VERIFY_RPC_URL_1/2`, which every visitor receives, so never a keyed
  URL. The page must not call the app's API; the end-to-end test answers
  `/api/*` with 503 and checks that no request carries the file.
- **Any doubt about the chain is a `CannotVerify`** with a named reason,
  raised by the registry view (`openRegistryView`), which checks chain id and
  bytecode on both endpoints and reads both at one finalized block. Do not
  turn one into a verdict, and do not catch unexpected errors inside
  `verifyFile`: the page shows them as "cannot verify right now".
- **Wording**: only AUTHENTIC_* verdicts say authentic or genuine, in either
  language, and every altered verdict says the file is not the registered
  file (`tests/unit/verify-wording.test.ts`).
- **A pending revocation is never authentic.** An exact match whose record, or
  whose original, has a revocation waiting out the registry's delay is
  REVOCATION_PENDING, with the time it takes effect; one in effect is REVOKED,
  which wins.
- **Three front ends, one core.** `/verify`, `dist/verifier.html` and the CLI
  (`standalone/`, built by `scripts/build-verifier.ts`) all call `verifyFile`.
  The HTML file inlines everything, pdf.js's worker included, writes only text
  into the page, and carries its own CSP: scripts by hash plus the worker's
  `blob:`, and connections to the two endpoints only.
- **The tamper suite is the exit gate** (`tests/tamper/`): each case is made
  with the tool a person would use (an incremental save, a re-render keeping
  the reference, qpdf, Chromium's print) and must get the same verdict from
  verify-core and from the CLI. A change to a verdict changes this table.
- **`src/proxy.ts` guards the verifier's pages**: a per-request nonce CSP
  (`src/lib/csp.ts`) whose `connect-src` is the origin and the two endpoints,
  and the lookup page's rate limit (`src/lib/rate-limit.ts`: 60 a minute per
  address, 600 in all; the address only behind a proxy that sets it,
  `TRUST_PROXY_HEADERS=1`). Neither covers the signed-in app.

## Roles and two-step sign-in

- **Who may do what is one table**, `CAN` in `src/lib/roles.ts`: ADMIN,
  PREPARER, APPROVER and VIEWER (who reads and nothing else). Use cases call
  `requireRole(user, act)`; every mutating route passes `{ may: act }` to
  `handler()`, which refuses before anything runs. UI checks use `mayDo`.
  Never test a role name inline. `tests/unit/route-roles.test.ts` finds every
  route through git and proves a VIEWER is refused with 403.
- **APPROVER and ADMIN sign in with TOTP** (`src/lib/mfa.ts`, otplib). The
  secret is sealed; a code is accepted only for a later time step than the
  last one (a conditional write, so two racing sign-ins cannot both pass);
  recovery codes are stored as SHA-256 and shown once. Until the second factor
  is set up, the session is `mfa: 'ENROLL'`: pages redirect to `/account/mfa`
  and routes answer `MFA_REQUIRED`, except the two setup routes.
- **Rate limits** (`src/lib/login-throttle.ts`, `src/lib/rate-limit.ts`):
  sign-in 10 attempts a minute per address, lockout after 5 failures per email
  or 10 per address in 15 minutes; writes 60 a minute per user (429 with
  `Retry-After`). The address is read only with `TRUST_PROXY_HEADERS=1`.
- **E2E**: the seeded approver and admin have two-step sign-in on with
  `SEED_APPROVER_TOTP_SECRET` and `SEED_ADMIN_TOTP_SECRET`, and
  `tests/e2e/helpers.ts` computes their codes;
  each person in a test signs in from a client address of their own
  (`fromOwnAddress`), since the per-address limit is real.

## The console

- **Signed-in pages live in the `(console)` route group**, whose layout holds
  the header and the nav. It is not a guard: each page still calls
  `requireUser()` itself.
- **Lists are `ConsoleTable`** (`src/components/console/console-table.tsx`):
  TanStack Table v9 inside the vendored Card, searched, sorted and paged in the
  browser over rows the server already scoped to the firm. Columns hold
  functions, so they are defined in a client component. A list that loads at
  most N rows reads N + 1 and says when it was cut (`CLIENT_LIST_CAP`), rather
  than letting a search look complete.
- **Charts are the vendored `TimeSeriesChart`, `Bars` and axes**, through
  `CountChart`, which adds the figures as a table (the chart itself is
  `aria-hidden`) and honours reduced motion. Days and months are UTC
  (`src/lib/console/periods.ts`).
- **Anchors per month come from the audit log** (`anchor.final`,
  `anchor.linked`), whose time never changes, not from a journal row's
  `updatedAt`.
- **Lookups are counted, never logged**: `recordLookup` adds one to
  `LookupCount` (firm, UTC day) for a family this server issued, after the
  `/r/<familyId>/latest` response is sent, and never throws. No family id, no
  address, no time of day is stored. `/verify` runs in the visitor's browser
  and is not counted.

## Recipients and the mailer

- **Recipients belong to an engagement** (`src/lib/reports/recipients.ts`): a
  PREPARER or ADMIN keeps the list (`manageRecipients`), one live entry per
  lower-cased address (a partial unique index). Removing someone keeps the
  row and cancels what was not yet sent to them.
- **Notices are an outbox.** When a version 2 or later becomes COMPLETE, the
  worker queues one `Notification` per live recipient in the same transaction
  (`queueSupersededNotices`, `src/lib/notifications/queue.ts`); when a
  revocation takes effect and a version is REVOKED, one of kind REVOKED
  (`queueRevokedNotices`, #96), never while it is only scheduled, since the
  owner may still cancel it. Do not send
  mail from a use case or the worker: only the mailer sends
  (`src/lib/notifications/mailer.ts`, run by `scripts/mailer.ts`), at least
  once, under a lease, giving up after five attempts (FAILED).
- **The email carries no PDF, no opinion and no figure** (decision #8):
  names, the engagement's reference, the period end, the version number and
  two links, as plain text with no attachment (`supersededEmail`,
  `revokedEmail`, `src/lib/notifications/email.ts`). A withdrawal names the
  reason's fixed label, never the admin's sealed note. Every value from the database passes
  through `oneLine`. Never add a field from the report or the opinion, and
  never store or log what an SMTP server said: only a name for the error.
- **`SMTP_URL` can hold credentials** and is never logged. Development and CI
  send to Mailpit (`docker-compose.yml`; a service container in CI), and the
  end-to-end test reads what was sent through Mailpit's API.

## The audit log and backups

- **`/audit-log` re-derives the chain on every view** and shows the last
  nightly check. `npm run audit:check` (`src/lib/audit-check.ts`) records
  every run in `AuditChainCheck` and holds the chain to the last intact check:
  it may only have grown, and its old head must still be there. That catches
  a tail cut off (`TRUNCATED`) and history rewritten and re-hashed
  (`REWRITTEN`), which the chain alone would pass. Because the last intact
  check is in the same database, it is also held to the chain (#94): every
  head in the registry that is not voided must still be the hash of an event
  (`ANCHORED_HEAD_MISSING`), read on both endpoints through
  `registryHeadWitness` (`src/lib/anchoring/audit-head.ts`); an unreadable
  chain is `CHAIN_UNREADABLE`, never a pass. Do not weaken this to the latest
  head only: the database owner can queue rows, so could have the worker write
  a rewritten log's head. A broken check puts a banner on every console page
  and stays reported; a check older than 36 hours shows as stopped.
- **Backups** are `scripts/backup.sh` (`pg_dump` custom format, the store as
  it is on disk, `SHA256SUMS`); `FILE_ENCRYPTION_KEY` is never in a backup.
  `scripts/restore.sh` restores only into an empty database and an empty
  directory, and `scripts/verify-restore.ts` checks the copy. CI runs the
  round trip after the end-to-end tests (`npm run test:backup`).

## Conventions

- Dependencies are exact versions (`.npmrc` has `save-exact=true`).
- UI strings go through next-intl. `messages/en.json` and `messages/bg.json`
  must carry the same keys; a test enforces it, and it also refuses an app key
  that collides with a vendored one.
- Secrets never enter the repository. Only `.env.example` is committed, with
  names and no values.
- Use the vendored primitives rather than hand-rolling a button, input, modal
  or badge.
