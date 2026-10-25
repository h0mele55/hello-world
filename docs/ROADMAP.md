# Audit Report Anchoring — Roadmap

As of 2026-10-25. This is the repository copy of the roadmap that sessions in
this repo read. When the plan changes, change it here in the same pull request.

The prototype records SHA-256 commitments for each audit report on Ethereum
Sepolia through a small registry contract, writes the block and transaction
back into the PDF, chains every reissue to its predecessor so any copy resolves
to the latest version, and lets outside parties verify in their own browser
without uploading the file. Phases 0–4 deliver the working prototype; phases
5–6 take it toward production.

## Can it be done

Every requirement maps to a proven technique; none needs research. Four
caveats shape the design.

| Requirement | How it is met | Caveat |
| --- | --- | --- |
| Hash the PDF and its metadata | SHA-256 of the exact file bytes, plus a salted SHA-256 of a canonical JSON manifest (client, period, version, opinion type, page count) | Any byte change, even a re-save, breaks the file hash. That is the point. |
| Point the hash to a free testnet | A registry contract on Ethereum Sepolia stores the commitments; each anchor is a transaction in a block | Testnets promise no durability |
| Link the PDF to its block | After the anchor is final, block number, transaction hash, contract and record id are written into the PDF's XMP metadata; that stamped copy is anchored too, as a child of the original | Writing into a PDF changes its hash, so each issue takes two anchors |
| Point old copies to the latest version | Each reissue names its predecessor; the contract refuses a fork and keeps `latestOf(family)` | A family is client + period end + report type + engagement, pseudonymised on chain |
| Let outside parties verify | The browser hashes the file locally, reads the contract directly, and returns Authentic, Superseded, Revoked, Altered or Not registered | Works with the app's server down; nobody has to trust it |
| Show the audit opinion is unchanged | A salted commitment to the normalised opinion paragraph, confirmed by the auditor before anchoring | An exact-file match is proof; an opinion match on an altered file is only a signal |

**Testnet durability.** ethereum.org calls Sepolia "the recommended default
testnet for application development" and lists no end-of-life date, but a
successor has been discussed publicly. Treat anchors as prototype evidence.
Phase 1 puts the chain behind an adapter, and Phase 6 adds a re-anchoring
procedure.

**What the opinion check can prove.** Text extraction is not a security
boundary: a PDF can display one text and expose another to extraction. So an
opinion mismatch is strong evidence of alteration, while an opinion match on a
non-identical file reads "file altered, opinion text appears unchanged", never
"authentic".

**Embedding changes the hash.** The original is anchored first, then the
stamped copy as its child. A PDF that already carries the auditor's digital
signature is anchored but not rewritten, because rewriting would break the
signature.

**`@inflect/ui` cannot be installed with npm.** It is source-only, private and
BUSL-1.1, and npm cannot install a subdirectory of a git repository. This repo
vendors it at a pinned commit (see `vendor/inflect-ui/README.md`).

## At a glance

```
Issuer console                    Contract · Sepolia                 Verifier · browser
1 Upload v1 (hash + manifest)     stores only hashes and a           Drop a PDF (hashed locally)
2 Confirm the opinion             pseudonymous family id;                  |
3 Approve and anchor  --tx 1-->   v1 original                        Read the contract (2 RPCs)
4 Stamp the PDF       --tx 2-->   v1 stamped copy (child of v1)            |
5 Reissue as v2       --tx 3-->   v2 original (parent v1, latest)    Verdict
                                  refuses a reissue that does         Authentic latest / Superseded /
                                  not name the latest                 Revoked / Altered / Not registered
```

Steps 3 to 5 each send one transaction. The verifier only reads, so it needs
no account and no trust in the app's server.

## Key design decisions

Each choice favours verification that needs no trust in the app over
convenience. Each row is an ADR under `docs/adr/`.

| Decision | Recommendation | Rejected alternative, and why |
| --- | --- | --- |
| Chain | Ethereum Sepolia (chain id 11155111), behind a chain adapter | Base Sepolia or Polygon Amoy: faster blocks and easier faucets, but Base Sepolia settles to Sepolia and shares its lifecycle. Bitcoin via OpenTimestamps: free and durable, but it cannot hold a version chain, so it becomes the Phase 6 second anchor. |
| On-chain structure | A small immutable registry contract: issuer allowlist, `anchor`, `revoke`, `recordOfDoc(hash)`, `latestOf(family)` | Ethereum Attestation Service: no contract to write, but "latest version" needs an off-chain indexer, so the verifier would trust a third party |
| What goes on chain | Only 32-byte commitments: file hash, salted manifest hash, salted opinion commitment, pseudonymous family id, version, parent | Client names or opinion types in clear: a public chain is permanent, and who audits whom is confidential |
| Hash function | SHA-256 throughout; browsers compute it natively with WebCrypto | Keccak-256: native to Ethereum, but the browser verifier would need a library for it |
| Linking the PDF to its block | Two anchors: the original, then the stamped distribution copy as its child | One anchor plus an incremental-update stamp: one transaction fewer, but the verifier must prove the appended section touches only metadata, the "shadow attack" surface PDF signatures suffer from |
| PDFs already signed | Anchor only, and issue a separate one-page verification certificate | Rewriting the PDF: invalidates the auditor's PAdES or qualified signature |
| PDF library | `pdfjs-dist` (Apache-2.0) to read, `@cantoo/pdf-lib` (MIT, updated September 2026) to write | `pdf-lib`: last updated in 2022 |
| Finding the opinion | Deterministic heading search (ISA 700/705 wording, English and Bulgarian), then the auditor confirms text and type | Fully automatic or LLM extraction: an unconfirmed guess would be committed permanently |
| Verification | In the browser: the PDF never leaves the device, and the contract is read straight from public RPC endpoints | Server-side upload: puts confidential reports on our server and makes it a party everyone must trust |
| Chain writes | Inflect's write ladder (DISABLED, DRY_RUN, LIVE), a journal row before every broadcast, and four-eyes approval | Fire-and-forget signing: an anchor is public and permanent, and a mistaken one can only be revoked, never removed |

## Using Inflect

`@inflect/ui` supplies the visual layer and Inflect's server patterns supply
the safety rails; nothing from Inflect's `src/` is imported at run time.

| This repo needs | Where it lives in inflect-compliance | How this repo gets it |
| --- | --- | --- |
| Button, Card, Tooltip, Typography, EmptyState, ErrorState, Skeleton | `packages/ui` | Vendored as is |
| Icons, `cn`, hooks such as `useCopyToClipboard`, `useMediaQuery` | `packages/ui` | Vendored as is, only what an entry point imports |
| Charts (time series, bars) for the issuer dashboard | `packages/ui/src/components/ui/charts` | Vendored in Phase 5, with the `@visx/*` packages it needs |
| Input, Textarea, FormField, Modal, Sheet, StatusBadge, CopyButton, ConfirmDialog | `src/components/ui`, classified GENERIC but not yet moved into the package | Vendored with their import closure, `@/components/ui/*` rewritten to `@inflect/ui/...` |
| DataTable | `src/components/ui/table`, classified MIXED | Not portable yet; use `@tanstack/react-table` inside the vendored Card |
| Theme | `packages/ui/tokens.contract.css`, 47 tokens | Overridden in `src/styles/theme.css`, light and dark |
| Canonical JSON | `src/lib/canonical-json.ts` | Copied with its tests in Phase 2 |

Patterns carried over as designs, not code:

- **Write ladder and journal before write:** every chain write moves DISABLED,
  DRY_RUN, LIVE, and a journal row exists before the transaction is broadcast.
- **Accepted is not applied:** a returned transaction hash is not an anchor;
  only a final block is.
- **Hash-chained audit log:** each internal action row carries the hash of the
  previous one.
- **Zero is never complete, and refusals are named:** an empty or unreadable
  result is refused with a reason, never reported as a pass.
- **Field encryption at rest:** stored PDFs and manifests are encrypted.
- **Rate-limit tiers:** a stricter limit on login and mutations than on public
  lookups.

## Rules every phase keeps

These are repeated in `CLAUDE.md`, and each phase's hardening list tests the
ones it touches.

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

## Roadmap

| Phase | Builds | Exit gate |
| --- | --- | --- |
| 0 · Foundation | Next.js app, vendored `@inflect/ui`, CI | CI green; kitchen sink renders in both themes; editing one vendored byte turns CI red |
| 1 · Registry contract | Sepolia contract and chain adapter | Contract source-verified on Sepolia Etherscan; fuzz and invariant tests pass |
| 2 · PDF hashing | Commitments, opinion locator, manifest | Identical hashes across runs and systems; opinion found in at least 90% of digital PDFs |
| 3 · Anchoring and versions | Journal, four-eyes, stamping, reissue | v1 and v2 anchored on Sepolia; a forked v2 reverts; a killed worker reconciles |
| 4 · Public verifier | In-browser verdicts, tamper suite | Every tamper case gets its expected verdict; verifies with the app's server down |
| — | **Prototype complete** | |
| 5 · Issuer console | Roles, revocation, recipients, audit log | Two-person demo: issue, approve, supersede, notify a recipient, revoke |
| 6 · Production path | Production chain, KMS keys, legal review | Owner sign-off on chain, keys and legal view; external review findings closed |

Each phase is one pull request, run from its prompt below in a fresh session.
Do not start a phase until the previous phase's exit gate holds.

## Phase 0 — Foundation and vendored Inflect UI

**Goal:** a Next.js app that renders Inflect's primitives in its own theme,
with the vendored copy pinned to one Inflect commit and checked for drift in
CI.

**Builds**

- Next.js 16 (App Router), React 19, TypeScript strict, Tailwind CSS 4,
  next-intl (English and Bulgarian), ESLint, Vitest, Playwright, GitHub Actions
  CI.
- `scripts/sync-inflect-ui.mjs`: copies the import closure of the configured
  entry points from a pinned inflect-compliance commit into
  `vendor/inflect-ui/`, and writes a manifest of file hashes.
- A tsconfig alias `@inflect/ui/*` → `vendor/inflect-ui/src/*` (the same
  mapping inflect-compliance itself uses); Tailwind `@source` over the vendored
  code; a theme overriding all 47 contract tokens.
- `CLAUDE.md` with the nine rules above, this file, and one ADR per row of the
  decisions table.
- A `/kitchen-sink` page showing every vendored primitive in light and dark.

**Exit gate:** CI runs lint, typecheck, tests and build green; the kitchen sink
renders with no transparent surfaces; editing one vendored byte turns CI red.

**Hardening**

- [ ] CI re-hashes every vendored file against the manifest, so a hand edit under `vendor/` fails
- [ ] The sync script refuses any vendored file that still imports `@/` or anything outside the package
- [ ] The Inflect commit is pinned in the manifest, and moving it is its own pull request
- [ ] `vendor/inflect-ui/LICENSE` (BUSL-1.1) travels with the copy
- [ ] `npm audit --omit=dev --audit-level=moderate` and a gitleaks secret scan run in CI
- [ ] Only `.env.example` is committed; `.env*` is git-ignored
- [ ] Dependencies are exact-pinned, with Dependabot weekly

## Phase 1 — Registry contract on Sepolia

**Goal:** an immutable contract that stores commitments, enforces the version
chain, and answers "is this file registered, and what is the latest version?"
in one read.

**Builds**

- A Foundry project in `contracts/` with `AuditReportRegistry.sol`.
- A record holds family id, file hash, manifest hash, opinion commitment,
  version, kind (ORIGINAL or DISTRIBUTION_COPY), parent, issuer, block number
  and revoked flag.
- `anchor` (issuer only): version 1 has no parent; version n+1 must name the
  family's current latest as parent, so a stale or forked reissue reverts.
- `anchorDistributionCopy(originalId, docHash)`: one copy per original; it does
  not move `latestOf`.
- `revoke(recordId, reasonCode)`: terminal.
- Reads: `recordOfDoc(docHash)`, `latestOf(familyId)`, `getRecord(id)`.
- Issuer keys map to an issuer organisation. A family belongs to the
  organisation that anchored version 1, and only that organisation's keys may
  extend or revoke it.
- Events `Anchored`, `Revoked`, `IssuerSet`, indexed by family, so history can
  be rebuilt from logs alone.
- A TypeScript `ChainAdapter` built on viem, with a Sepolia implementation and
  a local Anvil one for tests.

**Exit gate:** the contract is deployed and source-verified on Sepolia
Etherscan; unit, fuzz and invariant tests pass; an adapter test anchors and
reads back on Anvil.

**Hardening**

- [x] Invariant tests: a file hash maps to one record; versions per family run 1, 2, 3 with no gaps; a family has exactly one latest; revocation never reverses; a non-issuer never writes
- [x] Fuzzing of `anchor` with random parents and versions; the stale-parent race reverts
- [x] Slither clean, or each finding written off in the PR; no proxy, no `delegatecall`, no payable function
- [x] A zero hash or zero family id is rejected
- [x] The adapter checks chain id and deployed bytecode hash before any write
- [x] Deployer and issuer are different keys, from env only; the deployer holds at most 0.1 Sepolia ETH
- [x] Gas per anchor measured with `forge snapshot` and checked in CI

**As built (2026-10-25).** Everything above holds except the Sepolia
deployment, which waits on funded keys ([#4](https://github.com/h0mele55/hello-world/issues/4),
[#25](https://github.com/h0mele55/hello-world/issues/25)). Departures from the
prompt below, each deliberate:

- **Deploy script in TypeScript, not `Deploy.s.sol`.** `scripts/deploy-registry.ts`
  uses the same viem code the adapter uses, checks the deployed bytecode hash
  before it writes `deployments/<network>.json`, refuses to overwrite that file,
  refuses an issuer key equal to the deployer key, and refuses a deployer
  holding more than 0.1 ETH.
- **Two-step ownership** (`transferOwnership` then `acceptOwnership`), so a
  mistyped address cannot strand the issuer allowlist.
- **A key's organisation is fixed for life.** `setIssuer` refuses to move a key
  to another org (`IssuerOrgImmutable`); otherwise that org could extend or
  revoke families it never anchored.
- **`familyOrg` is derived, not stored**: the latest record's issuer names the
  org, which the rule above makes sound. With the record packed into six slots
  this keeps a first anchor under 200,000 gas.
- **`revokeReason` is `uint8`, `blockNumber` is `uint40`**, so the issuer and
  the five small fields share one slot.
- **A distribution copy costs about 225,000 gas**, more than an anchor, because
  it copies the original's commitments into its own record so one `getRecord`
  answers a verifier. The CI ceiling for it is 250,000.
- **Every write is simulated before it is sent**, so a refusal arrives as the
  contract's named error and no transaction is broadcast.
- `waitFinal` re-reads the receipt once the block is final and refuses a
  transaction that a reorg dropped (`TX_DROPPED`).

**Prompt**

```text
Work in h0mele55/hello-world. Read CLAUDE.md first; its rules bind this phase. Build Phase 1: the on-chain registry and the chain adapter. No PDF work yet.

1. Foundry project in contracts/. AuditReportRegistry.sol, Solidity 0.8.x, no proxy, no delegatecall, no payable functions, no external calls.
   - struct Record { bytes32 familyId; bytes32 docHash; bytes32 manifestHash; bytes32 opinionCommitment; uint32 version; uint8 kind; /* 0 ORIGINAL, 1 DISTRIBUTION_COPY */ bytes32 parentId; address issuer; uint64 blockNumber; bool revoked; }
   - recordId = keccak256(abi.encode(block.chainid, address(this), familyId, version, kind)).
   - Issuers: owner-managed mapping address => (bytes32 orgId, bool active). A family's orgId is fixed by the key that anchors version 1; only active keys of that org may extend or revoke it.
   - anchor(familyId, version, parentId, docHash, manifestHash, opinionCommitment): reverts on zero hashes; version 1 requires parentId == 0 and no existing family; version n+1 requires parentId == latestOf[familyId] and that record's version == n; docHash must be unused; sets latestOf[familyId].
   - anchorDistributionCopy(originalId, docHash): original must exist, be ORIGINAL, and have no copy yet; same org; docHash unused; does not change latestOf.
   - revoke(recordId, uint16 reasonCode): same org; terminal; reverts if already revoked.
   - Views: recordOfDoc(bytes32) returns (bytes32 recordId), latestOf(bytes32), getRecord(bytes32).
   - Events: Anchored(recordId indexed, familyId indexed, docHash indexed, version, kind, parentId), Revoked(recordId indexed, reasonCode), IssuerSet(issuer indexed, orgId, active).
   - Custom errors with clear names (StaleParent, DocAlreadyAnchored, NotFamilyIssuer, ...).
2. Tests: unit tests for every revert; fuzz anchor with random versions and parents; invariant tests (docHash -> one record; per-family versions contiguous from 1; exactly one latest per family; revoked is terminal; non-issuers never write). forge snapshot for gas, checked in CI. Run Slither in CI; fix or justify each finding in the PR description.
3. script/Deploy.s.sol deploying to Sepolia (chain id 11155111) from DEPLOYER_PRIVATE_KEY, then setting ISSUER_ADDRESS as an issuer. Write deployments/sepolia.json { address, txHash, blockNumber, bytecodeHash }. Verify source on Etherscan. Add .env.example entries: SEPOLIA_RPC_URL, SEPOLIA_RPC_URL_2, DEPLOYER_PRIVATE_KEY, ISSUER_PRIVATE_KEY, ETHERSCAN_API_KEY. Never commit a key.
4. src/lib/chain/: a ChainAdapter interface { anchor, anchorCopy, revoke, findByDocHash, latestOf, getRecord, waitFinal } and two viem implementations: Sepolia (reads deployments/sepolia.json) and Anvil (deploys the contract in tests). Before any write, assert chainId and that the deployed bytecode hash matches deployments/*.json. waitFinal resolves only when the receipt's block is at or below the 'finalized' block tag.
5. Integration test: start Anvil, deploy, anchor v1, anchor v2, attempt a stale v2 (expect StaleParent), anchor a distribution copy, revoke, and read each back through the adapter.
6. If I have given you funded keys in the environment, deploy to Sepolia and record the addresses; otherwise stop after the Anvil test and list exactly what I must provide.

Finish: forge test, lint, typecheck, unit and integration tests green; commit on a branch, push, open a PR to master, report each check by name, and paste the Etherscan link if deployed.
```

## Phase 2 — PDF hashing and the opinion commitment

**Goal:** turn a PDF into deterministic commitments and a manifest that a
person has confirmed. Nothing touches the chain yet.

**Builds**

- Postgres (docker-compose) and Prisma: Client, Engagement (the report
  family), ReportVersion, StoredFile. A minimal Auth.js credentials login with
  two seeded users, a preparer and an approver.
- Upload, preparer only: the file must start with `%PDF-`, be at most 25 MB and
  500 pages, and not be encrypted. An existing signature (`/ByteRange`)
  switches the version to anchor-only. JavaScript, embedded files and XFA forms
  are flagged to the user.
- Parsing runs in a worker thread capped at 20 seconds and 512 MB, using
  `pdfjs-dist` for text and for Info and XMP metadata.
- Opinion locator: finds the opinion heading and takes the text up to the next
  "Basis for" heading. English headings are Opinion, Qualified Opinion, Adverse
  Opinion and Disclaimer of Opinion; Bulgarian are Мнение, Квалифицирано
  мнение, Отрицателно мнение and Отказ от изразяване на мнение. Confirm both
  lists against real reports.
- Normaliser v1: Unicode NFKC, re-joins words hyphenated across lines,
  collapses whitespace, drops running headers and footers. Its version is
  recorded in the manifest.
- A confirmation screen built from vendored Card, FormField, Textarea and
  StatusBadge: the extracted opinion beside the rendered page, which the
  preparer confirms or corrects, type included.
- Commitments: `docHash` = SHA-256 of the file bytes; `familyId` =
  HMAC-SHA256 under the issuer's secret over the client's registration number
  (the UIC in Bulgaria), period end, report type and the firm's engagement id,
  so standalone and consolidated reports for one year are separate families
  ([#6](https://github.com/h0mele55/hello-world/issues/6)); `opinionCommitment` =
  SHA-256 over a fresh 32-byte salt, the opinion type and the normalised text;
  `manifestHash` = SHA-256 of the canonical JSON manifest, which carries its
  own salt.

**Exit gate:** a fixture corpus in English and Bulgarian (digital, scanned,
signed, unsigned) gives identical hashes across two runs on two operating
systems. The opinion is located correctly in at least 90% of digital PDFs, and
every miss shows as "not found", never as a wrong passage.

**Hardening**

- [x] Golden tests pin `docHash`, `manifestHash` and `opinionCommitment` for fixed fixtures
- [x] Malformed-PDF fuzzing (truncated files, looping cross-references, decompression bombs) never crashes or hangs the server
- [ ] PDFs and manifests are encrypted at rest with AES-256-GCM; opinion text never reaches a log (2b)
- [ ] Salts come from a CSPRNG, fresh per version, and are never reused (CSPRNG in 2a; uniqueness is a database constraint in 2b)
- [x] A scanned PDF with no text layer is refused for the opinion check with a named reason, not OCR'd silently
- [x] The manifest carries a schema version, and readers refuse a version they do not know
- [x] Only synthetic PDFs are committed; public reports are fetched into a git-ignored cache by URL and expected hash

**As built: Phase 2 ships in two pull requests.** 2a is the hashing core with
no database and no UI: the parser, the locator and normaliser, commitments and
manifest, fixtures, golden and fuzz tests (#28, #29, #31, #32, #33). 2b adds
Postgres, sign-in, upload with encrypted storage and the confirmation screen
(#26, #27, #30). Departures from the prompt below, each deliberate:

- **The parser runs in a forked child process, not a worker thread.** A
  worker shares the server's memory, and V8's heap limit does not cover the
  ArrayBuffers a decompression bomb inflates into. The child gets a 512 MB
  heap and is killed at 20 seconds; whatever it answers is schema-checked.
  Every outcome is a parsed PDF or one of `NOT_A_PDF`, `TRUNCATED`,
  `TOO_LARGE`, `TOO_MANY_PAGES`, `TOO_MUCH_TEXT`, `ENCRYPTED`, `UNPARSEABLE`,
  `TIMEOUT`, `RESOURCE_LIMIT` or `PARSER_CRASHED`.
- **A file without `%%EOF` in its last kilobyte is refused as `TRUNCATED`.**
  pdfjs recovers what it can from a cut-off file, which would hand back part
  of a report as if it were whole.
- **Encrypted means any encryption**, including an owner password that only
  restricts editing. #74 asks whether to accept those anchor-only.
- **The family id preimage carries `v: 1`**, so a later key layout cannot
  collide with this one. The key is `registrationNumber` (spaces removed,
  upper-cased), `periodEnd`, `reportType` (`STANDALONE` or `CONSOLIDATED`)
  and `engagementRef` (#6).
- **The locator reads whole lines only.** An opinion heading must be the
  entire line and start with a capital letter. The basis heading must be the
  entire line and name the same opinion type. Running text that wraps to start
  with "Basis for Qualified Opinion section…", or a line holding just
  "opinion.", is therefore never taken for a heading. Bulgarian basis
  headings are read with and without "изразяване на".
- **Normaliser v1** applies NFKC, replaces lone surrogates, drops soft
  hyphens, zero-width and control characters, and collapses whitespace. At a
  line break, a letter, a hyphen and a lower-case continuation re-join into
  one word; any other hyphen stays, with no space added. A running header or
  footer is a line in the top or bottom three slots of a page whose
  digit-blind shape fills the same slot on at least two pages and half of all
  pages.
- **`reasonCode`** is one of `INITIAL` (version 1 only), `CORRECTION`,
  `SUBSEQUENT_EVENT` or `OTHER`.
- **The signed fixture carries a placeholder signature** (`/ByteRange`, zeroed
  `/Contents`). It exercises detection, not validation.
- **Canonical JSON** is Inflect's function copied verbatim, behind a strict
  guard that refuses `undefined`, non-integer numbers, `Date` and other
  non-plain values, which the copied function would silently coerce.

**Prompt**

```text
Work in h0mele55/hello-world. Read CLAUDE.md first; its rules bind this phase. Build Phase 2: PDF ingestion, hashing, opinion extraction and the confirmed manifest. No chain writes in this phase.

1. docker-compose with Postgres; Prisma models Client (name, registrationNumber, country), Engagement (clientId, engagementRef, periodEnd, reportType, familyId unique), ReportVersion (engagementId, version, status DRAFT|CONFIRMED, docHash unique, manifestHash, opinionCommitment, opinionType, anchorOnly, preparedById, confirmedAt), StoredFile (encrypted blob path, iv, keyVersion, sha256). Auth.js credentials login; seed two users: preparer and approver.

2. POST upload (preparer only). Validate: starts with %PDF-, at most 25 MB, at most 500 pages, not encrypted. Detect /ByteRange signatures and set anchorOnly. Flag /JavaScript, /EmbeddedFile and XFA. Store the file encrypted with AES-256-GCM (FILE_ENCRYPTION_KEY, random 12-byte IV, keyVersion).

3. Parse inside a worker_thread with resourceLimits.maxOldGenerationSizeMb = 512 and a 20 s timeout that terminates the worker. Use pdfjs-dist to extract text per page with positions, and to read the Info dictionary and XMP.

4. src/lib/opinion/: locateOpinion(pages) returns { type: UNMODIFIED|QUALIFIED|ADVERSE|DISCLAIMER, heading, text, pageRange, confidence } or { notFound: reason }. Match headings case-insensitively at line start: EN Opinion / Qualified Opinion / Adverse Opinion / Disclaimer of Opinion, stop at the next heading starting "Basis for"; BG Мнение / Квалифицирано мнение / Отрицателно мнение / Отказ от изразяване на мнение, stop at the next heading starting "База за". Never return a low-confidence span as found. normaliseOpinion v1: NFKC, re-join hyphenated line breaks, collapse whitespace, drop lines repeated on at least half the pages.

5. Confirmation page using the vendored Card, FormField, Textarea, StatusBadge and Button: shows the extracted text and type beside the rendered page (pdfjs canvas); the preparer may correct both, then confirms. Store the confirmed text encrypted.

6. src/lib/commitments.ts:
   - docHash = SHA-256(file bytes)
   - familyId = HMAC-SHA256(ISSUER_FAMILY_SECRET, canonicalJson({ registrationNumber, periodEnd, reportType, engagementRef }))
   - opinionSalt = 32 random bytes; opinionCommitment = SHA-256(opinionSalt || utf8(type) || 0x1f || utf8(normalisedText))
   - manifest v1 = { schema: 1, norm: 1, familyId, version, reasonCode, docHash, pageCount, reportDate, opinionType, opinionCommitment, manifestSalt } and manifestHash = SHA-256(canonicalJson(manifest)), using the canonicalJson copied from inflect-compliance src/lib/canonical-json.ts with its tests.
   Readers refuse an unknown schema or norm version.

7. Fixtures: generate synthetic audit reports in EN and BG with pdfkit (unmodified, qualified, adverse, disclaimer; one scanned-image only; one digitally signed). Commit only synthetic PDFs. scripts/fetch-public-corpus.mjs downloads public annual reports listed with URL and expected sha256 into a git-ignored cache. Golden tests pin docHash, manifestHash (with fixed test salts) and opinionCommitment; run them in CI on ubuntu and windows.

8. Fuzz: truncated files, looping xref tables, deeply nested objects, a 1 GB-expanding stream. The server must answer with a named refusal, never crash or hang.

Hardening, all true before you finish: encrypted storage; no opinion text or PDF bytes in logs; CSPRNG salts, fresh per version; scanned PDFs refused for the opinion check with reason NO_TEXT_LAYER; schema versions enforced; parser isolated with limits.

Finish: lint, typecheck, unit, golden and fuzz tests green; commit on a branch, push, open a PR to master, and report each check by name plus the opinion-locator hit rate on the corpus.
```

## Phase 3 — Anchoring, stamping and versions

**Goal:** an auditor issues version 1 of a report, and later version 2. Each
is anchored, stamped with its block and chained to its predecessor.

**Builds**

- A per-organisation write mode on Inflect's ladder: DISABLED; DRY_RUN, which
  simulates the call and records it without broadcasting; and LIVE.
- Four-eyes: the preparer confirms, and a different user approves the anchor.
- A `ChainWrite` journal that moves INTENT, BROADCAST (nonce, transaction
  hash), then FINAL (block), FAILED or INDETERMINATE. The INTENT row is
  written before the broadcast.
- A worker that claims journal rows, waits for the `finalized` block, and
  settles INDETERMINATE rows by reading the contract.
- Stamping with `@cantoo/pdf-lib`: XMP and Info entries carrying chain id,
  contract, record id, transaction hash, block number, family id, version,
  verify URL and the opinion salt. The page content is not touched. The
  stamped copy is then anchored as the original's DISTRIBUTION_COPY.
- Signed PDFs are anchored only, with a one-page verification certificate
  (record, block, transaction, QR code to the verifier).
- New version: pick the engagement, upload, choose a reason code (correction,
  reissue, subsequent events, other), confirm the opinion, approve. The
  contract enforces parent = latest.

**Exit gate:** on Sepolia, versions 1 and 2 of one engagement are anchored;
version 1's stamped copy resolves to version 2 as latest; a second version 2
reverts. Killing the worker mid-write leaves an INDETERMINATE row that settles
to the true state.

**Hardening**

- [ ] Idempotent: the same file twice returns the existing record and sends no transaction (database unique key plus `recordOfDoc` check)
- [ ] One writer per issuer key under an advisory lock; a stuck transaction is replaced at the same nonce with a higher fee, never a new nonce
- [ ] INDETERMINATE is never resent automatically; it settles from chain state
- [ ] The stamped PDF is re-parsed and re-hashed before its anchor, and its XMP block and transaction must equal the final record
- [ ] The testnet signing key lives in env on the server only and never reaches the browser
- [ ] A hash-chained internal audit log covers upload, confirm, approve, anchor, stamp and revoke
- [ ] An alert fires when the issuer balance drops below 0.02 Sepolia ETH

**Prompt**

```text
Work in h0mele55/hello-world. Read CLAUDE.md first; its rules bind this phase. Phases 1 (contract + ChainAdapter) and 2 (commitments + confirmed manifest) are merged. Build Phase 3: anchoring, stamping and versioning.

1. Organisation.chainWriteMode: DISABLED | DRY_RUN | LIVE, default DISABLED. Widening moves one rung at a time and is audited. DRY_RUN runs viem simulateContract and records the result; it never broadcasts. LIVE broadcasts.

2. Four-eyes: a CONFIRMED ReportVersion needs approval by a user other than its preparer (enforce in the usecase and with a database CHECK). Approval enqueues the anchor.

3. ChainWrite journal: { id, reportVersionId, kind ANCHOR|ANCHOR_COPY|REVOKE, status INTENT|SIMULATED|BROADCAST|FINAL|FAILED|INDETERMINATE, nonce, txHash, blockNumber, error, attempts }. Insert INTENT before any network call. A worker process (scripts/worker.ts) claims rows with SELECT ... FOR UPDATE SKIP LOCKED, takes a Postgres advisory lock per issuer key, assigns the nonce inside the lock, broadcasts, then waits until the receipt block <= the 'finalized' block. A timeout or crash between broadcast and receipt sets INDETERMINATE; reconcile it only by reading recordOfDoc(docHash) and the receipt, never by resending. A transaction pending over 10 minutes is replaced at the same nonce with a 20% fee bump.

4. Idempotency: before INTENT, if recordOfDoc(docHash) already exists on chain, link to it and send nothing.

5. Stamping (src/lib/stamp.ts, @cantoo/pdf-lib): after the ORIGINAL anchor is FINAL, write XMP under namespace https://github.com/h0mele55/hello-world/ns/audit-anchor/1.0/ and matching Info keys: chainId, contract, recordId, txHash, blockNumber, familyId, version, verifyUrl, opinionType, opinionSalt (hex), norm. Do not modify page content. Re-open the result with pdfjs, assert the XMP equals the FINAL record, hash it, then enqueue ANCHOR_COPY for it. Only after that copy is FINAL is the version COMPLETE and downloadable.

6. If the version is anchorOnly (already signed), never rewrite it. Generate a one-page certificate PDF (record id, hashes, block, tx, Etherscan link, QR code to /verify) instead.

7. New version flow on an existing Engagement: upload, reason code (CORRECTION=1, REISSUE=2, SUBSEQUENT_EVENTS=3, OTHER=9), confirm opinion, approve. parentId = latestOf(familyId) read at broadcast time; a StaleParent revert marks the write FAILED with that reason and asks the user to restart from the new latest.

8. Internal audit log: an append-only AuditEvent table, each row storing SHA-256(prevHash || canonicalJson(event)); write one for upload, confirm, approve, anchor, stamp, copy-anchor and revoke. A verifyAuditChain() function and test.

9. Balance check in the worker: log an error and surface a banner when the issuer key holds under 0.02 Sepolia ETH.

10. Tests on Anvil: v1 end-to-end to COMPLETE; v2 supersedes; a concurrent second v2 gets StaleParent; the same file twice sends one transaction; kill the worker after broadcast and prove the row reconciles to FINAL; DRY_RUN never broadcasts (assert the Anvil nonce is unchanged).

Hardening, all true before you finish: idempotency; single-writer nonce; INDETERMINATE never resent; stamped copy re-verified before its anchor; signing key server-side only; hash-chained audit log; balance alert.

Finish: tests green; if Sepolia keys are present, run v1 and v2 of a synthetic report on Sepolia and paste both Etherscan links; commit on a branch, push, open a PR to master, report each check by name.
```

## Phase 4 — Public verifier

**Goal:** anyone can drop a PDF on a page and learn, without uploading it,
whether it is authentic, which version it is, and what the latest version is.
This phase completes the prototype.

**Builds**

- `/verify`, no login: the browser hashes the file with WebCrypto and reads any
  embedded anchor reference with `pdfjs-dist`.
- The contract is read directly from two public Sepolia RPC endpoints with
  viem, and their answers must agree.
- Every verdict shows the issuer organisation, contract address, block and
  transaction, with Etherscan links, so a reader can check it by hand.
- `/r/{familyId}/latest` shows the latest version's details, without the PDF.
- The same logic ships as a single static HTML file and a Node CLI,
  `verify-report file.pdf`.

| Verdict | When | What it proves |
| --- | --- | --- |
| Authentic, latest | Exact file match, newest version, not revoked | The file is byte-identical to what the issuer anchored |
| Authentic, superseded | Exact match, a newer version exists | As above; links to the newest version's block and date |
| Revoked | Exact match, the issuer revoked the record | The file was issued and later withdrawn |
| Altered, opinion changed | No match; the file names a record; its opinion text gives a different commitment | Strong evidence the opinion was edited |
| Altered, opinion appears unchanged | No match; the file names a record; the opinion commitment matches | Only that the extracted opinion text matches; the file is still not the registered one |
| Not registered | No match and no reference in the file | Nothing either way |

**Exit gate:** every case in the tamper suite returns its expected verdict, and
`/verify` still works with the app's own API switched off.

**Hardening**

- [ ] Tamper suite: one-byte flip, metadata-only edit, opinion paragraph edit, opinion type flip, re-save in another tool, print to PDF, appended incremental update, hidden text overlay, stripped XMP, forged XMP naming another record
- [ ] A network-capture test proves no request carries PDF bytes
- [ ] Strict CSP: no inline script, `connect-src` limited to the two RPC hosts and the app's origin, no third-party scripts
- [ ] Disagreeing RPC endpoints or a wrong chain id return "cannot verify right now", never a verdict
- [ ] One opinion normaliser bundle serves server and browser, with golden tests run in both
- [ ] Wording reviewed against overclaiming, in English and Bulgarian; axe accessibility checks pass (WCAG 2.2 AA)
- [ ] The app's lookup API is rate-limited, and the verifier works without it

**Prompt**

```text
Work in h0mele55/hello-world. Read CLAUDE.md first; its rules bind this phase, especially 4, 5 and 7. Phases 1–3 are merged. Build Phase 4: the public verifier.

1. Move hashing, XMP reading, locateOpinion, normaliseOpinion and the opinion commitment into src/lib/verify-core/, isomorphic (browser and Node), with no server imports. Run the Phase 2 golden tests in Node and in a Playwright browser.

2. /verify (public, no login): a drop zone built from the vendored Card, EmptyState and StatusBadge. In the browser:
   a. docHash = WebCrypto SHA-256 of the bytes. The file is never sent anywhere.
   b. Read the contract with viem from NEXT_PUBLIC_RPC_URL_1 and NEXT_PUBLIC_RPC_URL_2. Check chainId 11155111 and the contract address from deployments/sepolia.json on both. If they disagree or either fails, show CANNOT_VERIFY with the reason; never a verdict.
   c. recordOfDoc(docHash) found: resolve a DISTRIBUTION_COPY to its original; read latestOf(familyId). Revoked (record, copy or original) -> REVOKED with reason code. original is latest -> AUTHENTIC_LATEST. Otherwise AUTHENTIC_SUPERSEDED, showing the latest version number, its block date and transaction.
   d. Not found: read the embedded XMP. If it names a record on this chain and contract, extract the opinion with verify-core, compute the commitment with the embedded salt, type and norm version, and compare with the original's opinionCommitment: different -> ALTERED_OPINION_CHANGED; equal -> ALTERED_OPINION_APPEARS_UNCHANGED; not extractable -> ALTERED_OPINION_NOT_CHECKABLE. Also show the family's latest version. XMP naming another chain or contract -> UNKNOWN_REGISTRY.
   e. No reference -> NOT_REGISTERED.
   f. Show the issuer organisation from public/issuers.json (orgId -> name); an orgId not in it reads "unknown issuer".

3. Copy, in en and bg: only AUTHENTIC_* may use the words authentic or genuine. ALTERED_OPINION_APPEARS_UNCHANGED must say the file is not the registered file. Every verdict links to Etherscan for the block and the transaction.

4. /r/[familyId]/latest: reads the chain and shows the latest version's number, block date, transaction and status. No PDF download.

5. Standalone: build verify-core into dist/verifier.html (one self-contained file, publishable on GitHub Pages) and a Node CLI bin/verify-report.mjs that prints the same verdict as JSON.

6. Tamper suite (tests/tamper/): from a COMPLETE stamped fixture, generate: one-byte flip; metadata-only edit; opinion paragraph edit; opinion type flip (Opinion -> Qualified Opinion); re-save with qpdf; print to PDF via Chromium; an appended incremental update; a white hidden-text overlay; XMP stripped; XMP forged to name another record. Assert each verdict, and assert the untouched original and stamped copy give AUTHENTIC_LATEST, then AUTHENTIC_SUPERSEDED once v2 exists.

7. Playwright: capture every network request during a verification and fail if any body contains PDF bytes; run with the app API returning 503 and assert verification still works; axe checks on /verify in both languages.

8. CSP: script-src 'self'; connect-src 'self' plus the two RPC hosts; worker-src 'self' blob:; no third-party scripts. Rate-limit the app's lookup endpoints at 60 requests per minute per IP.

Finish: all suites green; commit on a branch, push, open a PR to master, and report each check by name with the tamper-suite results table.
```

## Phase 5 — Issuer console and lifecycle

**Goal:** an audit firm can run the tool day to day: clients, versions,
revocations, recipients, and a log it could show a regulator.

**Builds**

- Roles ADMIN, PREPARER, APPROVER and VIEWER, with TOTP multi-factor sign-in
  for approvers and admins.
- A client and engagement list (`@tanstack/react-table` inside the vendored
  Card), and a version timeline per engagement with block and transaction
  links.
- A dashboard built on the vendored charts: anchors per month, writes in
  flight, verification lookups.
- Revocation: typed confirmation, a reason code, and four-eyes approval, then a
  REVOKE journal write.
- Recipients per engagement (a lender, a regulator, a shareholder). When a new
  version supersedes theirs, they get an email with the latest link, never the
  PDF.
- An audit log viewer that re-verifies the hash chain on screen, plus a nightly
  job that does the same and alerts on a break.

**Exit gate:** a two-person demo runs end to end: the preparer issues, the
approver approves, version 2 supersedes, the recipient is notified, and a
revocation shows as Revoked in the verifier.

**Hardening**

- [ ] Every mutating route checks role on the server; preparer ≠ approver is also a database constraint
- [ ] Multi-factor sign-in is required for APPROVER and ADMIN
- [ ] Sign-in and mutations are rate-limited, with lockout after repeated failures
- [ ] Notification emails carry no PDF, no opinion text and no figures
- [ ] The nightly audit-chain check alerts on any break
- [ ] Database and encrypted file store are backed up, and one restore has been tested

**Prompt**

```text
Work in h0mele55/hello-world. Read CLAUDE.md first; its rules bind this phase. Phases 1–4 are merged. Build Phase 5: the issuer console and lifecycle.

1. Roles on Membership: ADMIN, PREPARER, APPROVER, VIEWER. Enforce on the server in every route and usecase (a helper requireRole), and add a unit test per mutating route proving a VIEWER is refused with 403. TOTP multi-factor sign-in (otplib) is mandatory for APPROVER and ADMIN; recovery codes stored hashed.

2. /clients and /clients/[id]: a list with @tanstack/react-table inside the vendored Card (search, sort, pagination), using vendored Button, Input, StatusBadge, EmptyState, Skeleton. /engagements/[id]: a vertical version timeline; each version shows status, reason code, prepared and approved by, block, transaction (vendored CopyButton) and Etherscan links, and its stamped PDF or certificate download.

3. /dashboard with the vendored charts (vendor the charts folder now with the sync script and add its @visx dependencies): anchors per month, ChainWrite rows by status, verification lookups per day from the rate-limited lookup API.

4. Revocation: an ADMIN starts it with a typed confirmation (the engagement name), a reason code (WITHDRAWN=1, ISSUED_IN_ERROR=2, SUPERSEDED_AND_WITHDRAWN=3, OTHER=9) and a note; a different APPROVER approves; then a REVOKE ChainWrite runs through the journal. Use the vendored ConfirmDialog.

5. Recipients: Recipient { engagementId, name, email }. When a version becomes COMPLETE, email recipients of earlier versions with the /r/[familyId]/latest link. Email text contains no PDF, opinion text or figures. Use Mailpit in docker-compose for development.

6. /audit-log: lists AuditEvent rows and runs verifyAuditChain() showing intact or the first broken row. A nightly job runs the same check and logs an error on a break.

7. Rate limits: sign-in 10 per minute per IP with lockout after 10 failures in 15 minutes; mutations 60 per minute per user.

8. Backups: a documented pg_dump plus encrypted-store copy script, and a restore test in CI against a throwaway database.

9. Playwright: the two-user flow (issue v1, approve, issue v2, approve, recipient email appears in Mailpit, revoke v1, the verifier shows REVOKED for v1's file).

Finish: all suites green; commit on a branch, push, open a PR to master, report each check by name.
```

## Phase 6 — Production path

**Goal:** build what a real audit firm needs before relying on the tool, and
put the decisions only the owner can make in front of them with evidence.

**Builds and decisions**

- **Production chain**, the owner's decision: Ethereum mainnet, or a mainnet
  rollup such as Base, Optimism or Arbitrum, where an anchor costs cents. It is
  a new `ChainAdapter` implementation, plus optional Merkle batching (one
  transaction per batch, each PDF carrying its proof).
- **Re-anchoring:** commit a Merkle root of every Sepolia record to the
  production chain, so prototype anchors outlive Sepolia.
- **Second anchor** through OpenTimestamps on Bitcoin, so evidence survives the
  loss of any one chain.
- **Key custody:** issuer keys in Google Cloud KMS (secp256k1 signing) or an
  HSM; contract ownership moved to a Safe multisig; a tested rotation runbook.
- **Qualified signatures:** seal stamped PDFs with an eIDAS qualified
  electronic seal and an RFC 3161 timestamp. The anchor complements the
  signature; it does not replace it.
- **Legal and privacy:** a GDPR assessment (the on-chain commitments are
  salted, so deleting the off-chain salt and manifest leaves them unlinkable),
  engagement-letter wording, and the professional body's view on relying on
  it.
- **Assurance:** a STRIDE threat model, an external review of the contract, and
  a penetration test of the verifier and the console.

**Exit gate:** the owner has signed off chain, key custody and the legal view;
external review findings are closed; re-anchoring has been rehearsed on a copy.

**Hardening**

- [ ] The threat model covers a forged issuer, key theft, a lying RPC endpoint, a chain reorg or sunset, PDF parser exploits and an insider reissuing a report
- [ ] Key ceremony and rotation runbook rehearsed; old records still verify after a rotation
- [ ] Monitoring and on-call for failed writes, finality lag, RPC disagreement, low balance and verifier errors
- [ ] `/verify` load-tested at 50 requests per second
- [ ] Disaster recovery restores the database and re-derives every verdict from the chain
- [ ] The re-anchoring proof verifies every Sepolia record against the production root

**Prompt**

```text
Work in h0mele55/hello-world. Read CLAUDE.md first; its rules bind this phase. Phases 1–5 are merged. Phase 6 prepares production. Do not choose the production chain or move any ownership yourself: build the options and stop for my decision where marked.

1. docs/threat-model.md: STRIDE over the issuer console, worker, contract, verifier and PDF pipeline. Cover at least: forged issuer, issuer key theft, a lying or compromised RPC endpoint, chain reorg, Sepolia sunset, PDF parser exploits, an insider reissuing or revoking, and a recipient tricked by an ALTERED verdict. Each threat names its mitigation and the test that proves it, or states it is open.

2. KmsSigner: a viem custom account that signs with Google Cloud KMS EC_SIGN_SECP256K1_SHA256 (normalise s to low-s, recover v). Behind a SIGNER=env|kms switch. Integration test against Anvil with a mocked KMS client; a manual runbook for a real key.

3. ChainAdapter for a production network, configurable as Ethereum mainnet, Base, Optimism or Arbitrum, with deployments/<network>.json. Deploy only to the matching Sepolia-based testnet in this phase. Write docs/decision-production-chain.md comparing them on cost per anchor (measure gas from forge snapshot and quote current fees with sources), finality time, explorer support and dependence on third parties. STOP for my decision.

4. Merkle batching (optional, behind a flag): batch up to 256 anchors into one root, store each proof, embed the proof in the stamped XMP, and teach verify-core to check a proof. Golden tests.

5. scripts/reanchor.ts: read every Sepolia record from Anchored and Revoked logs, build a Merkle tree over canonical records, commit the root to a target adapter, and emit a proof file per record. The verifier accepts a Sepolia record either directly or via its proof against the committed root.

6. Second anchor: submit each manifestHash to OpenTimestamps; store the .ots proof; upgrade it once Bitcoin-confirmed; show it in the verifier as an independent timestamp.

7. Contract ownership: a script that proposes transferOwnership to a Safe address, for me to execute. Do not execute it.

8. docs/runbooks/: key rotation, RPC outage, stuck writes, Sepolia sunset, restore from backup. Rehearse key rotation on Anvil and prove old records still verify.

9. Load test /verify with k6 at 50 rps for 5 minutes against a staging deploy; record p95 and errors.

Finish: all suites green; commit on a branch, push, open a PR to master; list every point that waits on my decision.
```

## Open questions for the owner

- [x] **Repository.** Vendor BUSL-1.1 Inflect code into this public repository — accepted 2026-10-24 when Phase 0 started; `vendor/inflect-ui/LICENSE` carries the licence.
- [ ] **Sepolia funds.** Phase 1 needs a funded deployer key and issuer key in the environment. Several faucets require a mainnet balance, so these must come from the owner. Decided 2026-10-25: build and test on Anvil now, deploy when the keys arrive ([#4](https://github.com/h0mele55/hello-world/issues/4)). (Phase 1)
- [x] **What "the same report" means.** Decided 2026-10-25: the family key adds the firm's engagement id, so standalone and consolidated reports for one year are two families ([#6](https://github.com/h0mele55/hello-world/issues/6)). (Phase 2)
- [x] **Issuers.** Decided 2026-10-25: one audit firm for the prototype; the contract still keys families by organisation, so a second firm needs no new contract ([#5](https://github.com/h0mele55/hello-world/issues/5)). (Phase 1)
- [x] **Languages.** Decided 2026-10-25: English and Bulgarian ([#7](https://github.com/h0mele55/hello-world/issues/7)). (Phases 2 and 4)
- [ ] **Recipient access.** May recipients download the latest PDF, or only see its details and ask the auditor for it? (Phase 5)

## Sources

- [Networks, ethereum.org](https://ethereum.org/en/developers/docs/networks/): Sepolia is "the recommended default testnet for application development"; Holesky deprecated as of September 2025.
- [Glamsterdam testnet announcement, Ethereum Foundation blog, 17 September 2026](https://blog.ethereum.org/2026/09/17/glamsterdam-testnet-announcement): Glamsterdam scheduled on Sepolia for 6 October 2026.
- [testnets-2026](https://github.com/dallaspu/testnets-2026): Sepolia for application development, Hoodi for validators.
- [docs/shared-ui-package-design.md](https://github.com/rodnapamet/inflect-compliance/blob/main/docs/shared-ui-package-design.md) and [packages/ui](https://github.com/rodnapamet/inflect-compliance/tree/main/packages/ui), inflect-compliance: how the package is consumed, and why npm cannot install it from git.
- npm registry, read 24 October 2026: [@cantoo/pdf-lib](https://www.npmjs.com/package/@cantoo/pdf-lib) 2.11.1 (15 September 2026); [pdf-lib](https://www.npmjs.com/package/pdf-lib) 1.17.1 (2022); [pdfjs-dist](https://www.npmjs.com/package/pdfjs-dist) 6.4.299; [viem](https://www.npmjs.com/package/viem) 2.57.11.
