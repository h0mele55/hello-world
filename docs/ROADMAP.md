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
- [x] PDFs and manifests are encrypted at rest with AES-256-GCM; opinion text never reaches a log
- [x] Salts come from a CSPRNG, fresh per version, and are never reused
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
- **`ENCRYPTED` means a password is needed to open the file.** A file with
  only an owner password, which opens freely but restricts editing, is read
  and flagged `editProtected`; it is anchored without stamping, like a signed
  one (owner decision 2026-10-25, #74). Phase 2b sets `anchorOnly` for it.
- **The family id preimage carries `v: 1`**, so a later key layout cannot
  collide with this one. The key is `registrationNumber` (spaces removed,
  upper-cased), `periodEnd`, `reportType` (`STANDALONE` or `CONSOLIDATED`)
  and `engagementRef` (#6).
- **The locator reads whole lines only.** An opinion heading must be the
  entire line and start with a capital letter. The basis heading must be the
  entire line and name the same opinion type. Running text that wraps to start
  with "Basis for Qualified Opinion section…", or a line holding just
  "opinion.", is therefore never taken for a heading. Bulgarian basis
  headings are read with and without "изразяване на". Wordings seen in real
  reports are read too: a leading section number ("1 Our opinion is
  unmodified"), "… on the [consolidated] financial statements", "Basis to
  express audit opinion", and "одиторско" before "мнение".
- **Text is read column by column.** Annual reports set the auditor's report
  in two or three columns, which a line-by-line reading merges into lines that
  join both columns. The parser splits each page into bands of lines that
  share a gutter (at least 8 pt wide, with at least 15% of the band's text on
  each side), reads a band column by column, and ends a band at any line that
  crosses its gutter.
- **Measured on 24 public reports** (12 Bulgarian, 12 English; 2019–2025;
  unmodified, qualified and disclaimer opinions; listed in
  `tests/fixtures/public-corpus.json` by URL and SHA-256): the opinion is
  found in 21, and none is wrong. The gate counts PDFs holding one auditor's
  report (owner decision 2026-10-25): **20 of 21, 95.2%**. The one miss has
  a misspelled heading ("Квалифицирно"). Two PDFs that bundle two reports are
  refused as `MULTIPLE_OPINION_HEADINGS`; #77 lets the preparer choose.
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

2b, in the same spirit:

- **Sign-in is NextAuth v4 with credentials and JWT sessions**, the version
  Inflect pins, with the same Next 16 route shim. Two roles, `PREPARER` and
  `APPROVER`. Five failed sign-ins lock an email for 15 minutes; the address
  limit applies only behind a proxy that sets `X-Forwarded-For`
  (`TRUST_PROXY_HEADERS=1`), since a client can forge that header.
- **Every sealed value names what it protects.** Files, the extracted
  opinion, the confirmed opinion and the manifest are AES-256-GCM encrypted
  with the field and the version's `docHash` (or the file's path) as
  additional authenticated data, so a ciphertext moved to another row fails
  to open. Each stored file is also re-hashed on every read.
- **Salt uniqueness is a database constraint** (`opinionSalt` and
  `manifestSalt` are unique columns).
- **`CONFIRMED` is reachable only through `confirmOpinion`**, whose update is
  conditional on the row still being a draft, so two racing confirmations
  produce one. The screen asks again in a dialog that says the text becomes
  part of the commitment.
- **One draft per engagement at a time**, and a draft can be discarded (file
  included). Version n+1 needs a reason code (`CORRECTION`,
  `SUBSEQUENT_EVENT`, `OTHER`); anchoring it to its parent is Phase 3.
- **The upload is the raw PDF body** (`Content-Type: application/pdf`), read
  with a 25 MB cap that stops reading at the limit. A PDF that is signed or
  edit-protected (#74) is stored `anchorOnly`.
- **Database tests run against real Postgres**, migrated from scratch with
  `prisma migrate deploy`, and refuse any database whose name does not end
  in `_test`. Prisma refuses `migrate reset` from a coding agent without the
  owner's consent; the tests never need it.

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

- [x] Idempotent: the same file twice returns the existing record and sends no transaction (database unique key plus `recordOfDoc` check)
- [x] One writer per issuer key under an advisory lock; a stuck transaction is replaced at the same nonce with a higher fee, never a new nonce
- [x] INDETERMINATE is never resent automatically; it settles from chain state
- [x] The stamped PDF is re-parsed and re-hashed before its anchor, and its XMP block and transaction must equal the final record
- [x] The testnet signing key lives in env on the server only and never reaches the browser
- [x] A hash-chained internal audit log covers upload, confirm, approve, anchor, stamp and revoke (revoke arrived with the revocation flow in Phase 5c, #55)
- [x] An alert fires when the issuer balance drops below 0.02 Sepolia ETH

**As built: Phase 3 ships in two pull requests.** 3a is approval, the write
ladder, the journal, the worker, new versions, the audit log and the balance
alert (#34, #35, #36, #37, #40, #41, #42, and the Anvil half of #43). 3b is
stamping, the distribution copy and the certificate for anchor-only PDFs
(#38, #39). The Sepolia run of the exit gate waits on funded keys (#4).
Departures from the prompt below, and decisions it left open:

- **The worker signs locally, then journals, then sends.** It builds the
  transaction, signs it with the issuer key, and writes the nonce, the hash,
  the gas limit and both fee caps to the INTENT row before
  `eth_sendRawTransaction`. A worker that dies after that write leaves a row
  holding a hash whose fate nobody saw; once its lease runs out the next pass
  marks it INDETERMINATE (`SEND_OUTCOME_UNKNOWN`).
- **A send has three outcomes.** The node took the bytes (or already had
  them): BROADCAST. The node refused them before they reached its pool
  (insufficient funds, underpriced, fee below the base fee, intrinsic gas):
  FAILED, and the nonce is given back. Anything else, a timeout or a dropped
  connection included: INDETERMINATE.
- **INDETERMINATE is settled from the chain alone**, in this order: a receipt
  for any hash the row ever had, or the node still holding one in its pool
  (back to BROADCAST); else, once the issuer's *finalized* nonce has passed
  the row's, the record for its document (FINAL, linked) or `NONCE_CONSUMED`
  (FAILED). A row whose transaction is unknown and whose nonce is unused
  cannot be settled, and nothing guesses: it holds the issuer key, so no new
  LIVE write starts until an approver runs `scripts/settle-write.ts`, which
  uses that nonce with a zero-value transfer to the issuer, recorded in the
  audit log under their name before it is sent; the worker then reads the
  outcome (#78).
- **One worker per issuer key** holds a session advisory lock on a dedicated
  connection for its pass. A partial unique index on (chain, issuer, nonce)
  backs it: a second writer that picked the same nonce cannot journal it, so
  never signs or sends it.
- **A row keeps its nonce only while its transaction may land, or once its own
  transaction used it.** A refused send, a nonce used by another transaction,
  and a link to a record someone else anchored clear it, so it can be
  assigned again. The next nonce is the larger of the node's pending count and
  one past the highest nonce of a live row.
- **Replacement** re-signs the same call with the same gas at the same nonce,
  both fee caps raised by at least 20% (or to the current estimate, if
  higher), after 10 minutes pending. A replacement the node refuses leaves the
  original live and waits another window.
- **FINAL means the block is finalized and the record matches.** After
  `finalized` passes the receipt's block the receipt is read again (the same
  block hash), then the record: family, version, document, manifest, opinion
  commitment, parent, issuer and block must all equal what was sent. A
  mismatch is INDETERMINATE (`RECORD_MISMATCH`) and held for a person.
- **Idempotency**: before building, the worker reads `recordOfDoc`. A record
  that is this version (same family, version, manifest and opinion
  commitment) is linked once final, with its transaction found by the
  `Anchored` event; anything else is `DOC_ANCHORED_ELSEWHERE`. Nothing is
  sent either way.
- **Parent = latest, checked against our own records.** Version n > 1 can be
  approved only once version n − 1 is ANCHORED. The worker reads
  `latestOf(familyId)` just before simulating and refuses
  (`FAMILY_LATEST_MISMATCH`) unless it is version n − 1's record: a family
  whose latest is not the one we know is refused, not guessed (rule 7). A
  version 2 that lands between that read and our simulation fails by the
  contract's name, `StaleParent`, with nothing sent.
- **The ladder.** Widening moves one rung at a time; narrowing may jump
  straight to DISABLED and stops every write not yet sent (`MODE_NARROWED`).
  The mode is read when the row is written and again before it is sent. A
  DRY_RUN approval simulates, records SIMULATED with the outcome (the
  contract's error name, or none), and returns the version to CONFIRMED: a
  live anchor needs its own approval.
- **Every failure returns the version to CONFIRMED with the approval
  cleared**, so another attempt needs another approval. The database holds
  four-eyes (approver ≠ preparer and ≠ confirmer) and "APPROVED or beyond
  has an approver" as CHECK constraints, and at most one live write per
  version and kind as a partial unique index.
- **Reason codes stay as Phase 2 built them** (`CORRECTION`,
  `SUBSEQUENT_EVENT`, `OTHER`); the prompt's numeric codes and `REISSUE` were
  not adopted.
- **The audit log** chains `SHA-256(prevHash ‖ canonical JSON of the event)`
  per firm, appended in the same transaction as the change it records under a
  transaction-scoped advisory lock. A trigger refuses UPDATE and DELETE.
  Events carry ids, hashes, statuses and reason codes; never a client name,
  an opinion or a manifest.
- **The key boundary.** Only `scripts/issuer-env.ts` (the worker and the operator tools) reads `ISSUER_PRIVATE_KEY`;
  the app reads `ANCHOR_NETWORK` and `ISSUER_ADDRESS`. A unit test refuses
  the name anywhere under `src/`, the end-to-end server is started without
  it, and CI greps the build for the key.
- **Tested on Anvil and Postgres**: v1 to FINAL, v2 chained to v1, StaleParent
  with nothing sent, a document already on chain linked with nothing sent, a
  worker killed after sending settling to FINAL, bytes that never left
  holding the key until their nonce is used, a stuck transaction replaced,
  DRY_RUN leaving the nonce unchanged, a narrowed mode, a refused send, a low
  balance, a second worker locked out, and the worker script itself. The
  end-to-end test drives the UI through a dry run and a live anchor to FINAL
  on Anvil.

3b, stamping and the certificate (#38, #39):

- **The stamp is an incremental update.** `@cantoo/pdf-lib` appends a new
  catalog, Info dictionary and XMP stream after the original's `%%EOF`, so
  the original file is byte for byte the copy's prefix: its pages are
  untouched by construction, not by assertion. The XMP description sits in
  the namespace `https://github.com/h0mele55/hello-world/ns/audit-anchor/1.0/`
  beside any XMP the document already had; the Info keys mirror it
  (`AuditAnchorRecordId`, …). Fields: `stamp` (version 1), `chainId`,
  `contract`, `recordId`, `txHash`, `blockNumber`, `familyId`, `version`,
  `verifyUrl`, `opinionType`, `opinionSalt`, `norm`. No dates.
- **Stamping is deterministic**, so a retry produces the same copy: the
  registry allows one copy per original (`CopyExists`).
- **The copy is checked before it is stored or sent**: the decrypted original
  must hash to the anchored `docHash`; the original's record must be on chain,
  final, unrevoked and in the recorded block; the copy must begin with the
  original, re-parse in the isolated parser to the same pages, text and flags,
  and carry the expected stamp in both its XMP and its Info. Any failure is a
  named `STAMP_…` reason; the version stays ANCHORED and an approver can retry.
- **ANCHOR_COPY is queued in the transaction that makes the original FINAL**,
  and handled by the same journal and worker as the original: idempotent by
  `recordOfDoc`, a FINAL copy record must match family, version, commitments,
  parent and block. The version is COMPLETE, and the copy downloadable, only
  once the copy's block is finalized. A database CHECK holds that COMPLETE
  carries its proof.
- **Anchor-only versions get a one-page certificate** in English and
  Bulgarian (DejaVu Sans embedded for Cyrillic): document hash, record,
  family, network, contract, transaction, block, explorer link, and a QR code
  to the verifier, with the testnet disclaimer. It is not anchored: it points
  at the record, which vouches for the report. Of the 24 public reports in the
  corpus, 10 are signed or edit-protected and take this path; the other 14
  all stamp and pass the check.
- **The worker needs the file key** (`FILE_ENCRYPTION_KEY`, its version and
  `FILE_STORAGE_DIR`, the same values as the app's) and `APP_PUBLIC_URL`,
  which stamps and certificates point at. It still holds no other app
  secret: the encrypted file store is a factory (`src/lib/file-store.ts`)
  the app and the worker each configure.
- **Found on the way**: pdf.js 6 returns custom Info keys as a `Map`, which
  the parser's string filter silently dropped; it reads them now.


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

- [x] Tamper suite: one-byte flip, metadata-only edit, opinion paragraph edit, opinion type flip, re-save in another tool, print to PDF, appended incremental update, hidden text overlay, stripped XMP, forged XMP naming another record
- [x] A network-capture test proves no request carries PDF bytes
- [x] Strict CSP: no inline script, `connect-src` limited to the two RPC hosts and the app's origin, no third-party scripts
- [x] Disagreeing RPC endpoints or a wrong chain id return "cannot verify right now", never a verdict
- [x] One opinion normaliser bundle serves server and browser, with golden tests run in both
- [x] Wording reviewed against overclaiming, in English and Bulgarian; axe accessibility checks pass (WCAG 2.2 AA)
- [x] The app's lookup API is rate-limited, and the verifier works without it

**As built: Phase 4 ships in two pull requests.** 4a is the shared
verification code, `/verify`, the wording and `/r/{familyId}/latest` (#44,
#45, #46, #47). 4b is the standalone verifier and CLI, the tamper suite, the
privacy, resilience and accessibility tests, the CSP and the rate limit (#48,
#49, #50, #51). Departures from the prompt below, and decisions it left open:

- **One implementation, two runtimes.** `src/lib/verify-core/` holds line
  grouping, page and metadata reading, the opinion commitment, the
  two-endpoint registry view and the verdict; the server's isolated parser
  imports the same line, page and metadata readers. It imports only `viem`,
  `zod` and plain modules (`tests/unit/verify-core-imports.test.ts`), and the
  Phase 2 golden values are recomputed in Chromium by an esbuild bundle of it
  (`tests/e2e/golden-browser.spec.ts`).
- **The file is hashed with viem's SHA-256, not WebCrypto**: the same code
  gives the golden values in Node and the browser, and it needs no secure
  context, which a verifier opened from disk (4b) may not have.
- **The endpoints are `VERIFY_RPC_URL_1` and `VERIFY_RPC_URL_2`**, read by the
  server at request time and handed to the page, not `NEXT_PUBLIC_*` values
  baked in at build. They are public by definition, so they are separate from
  `SEPOLIA_RPC_URL`, which may carry a key; on Sepolia they must be https, on
  different hosts, without credentials. `VERIFY_NETWORK` defaults to
  `ANCHOR_NETWORK`. Choosing the two providers is part of the Sepolia run
  (#4).
- **Two endpoints, one block.** Each endpoint must report the chain id and
  hold the deployment's runtime bytecode; every read is made on both at the
  older of their two finalized blocks and must agree, or the answer is
  CANNOT_VERIFY with a named reason (`RPC_UNREACHABLE`, `WRONG_CHAIN`,
  `WRONG_CONTRACT`, `RPC_DISAGREE`, `CHAIN_INCONSISTENT`). Reading at a
  finalized block is also rule 2: a record whose block is not finalized is
  not found.
- **The issuer's name comes from the deployment record** (`issuer.orgName`,
  written by `scripts/deploy-registry.ts` from `ISSUER_ORG_NAME`), not from a
  separate `public/issuers.json`; an org id it does not name reads "unknown
  issuer".
- **Revocation** is judged on the matched record and its original: a revoked
  copy does not revoke the original it was made from. For an altered file the
  original's and the latest version's status are shown beside the verdict.
- **The verdict says what it proves.** Only AUTHENTIC_* say "authentic"
  (`tests/unit/verify-wording.test.ts`, both languages); every altered verdict
  opens with "This is not the file the issuer anchored"; NOT_REGISTERED names
  why (no reference, an unreadable one, one naming no record, an unreadable
  PDF). An error the verifier did not expect is shown as "cannot verify right
  now", never as a verdict.
- **`/r/{familyId}/latest` reads the chain on the server**, through the same
  two agreeing endpoints, and shows the record only.

4b, the standalone verifiers, the tamper suite and the hardening (#48, #49,
#50, #51):

- **Two more front ends on the same core.** `npm run build:verifier` bundles
  verify-core into `dist/verifier.html`, one self-contained page (pdf.js and
  its worker inlined, the registry settings and both languages baked in) that
  works opened from disk, and `dist/verify-report.mjs`, which
  `bin/verify-report.mjs` runs: the verdict as JSON, exit 3 for "cannot verify
  right now". The page writes only text into the document and carries its own
  CSP: its script by hash, the worker as `blob:`, connections to the two
  endpoints only. Publishing it for Sepolia is #85, after #4.
- **The tamper suite** (`npm run test:tamper`, on Anvil) starts from a
  COMPLETE version and checks every case through verify-core and through the
  CLI, which must agree. Its table is the exit gate:

  | Case | Verdict |
  | --- | --- |
  | Untouched original, untouched stamped copy | AUTHENTIC_LATEST; AUTHENTIC_SUPERSEDED once v2 is anchored |
  | One-byte flip (the binary marker comment) | ALTERED_OPINION_APPEARS_UNCHANGED |
  | Metadata-only edit (an incremental save of the title) | ALTERED_OPINION_APPEARS_UNCHANGED |
  | Opinion paragraph edited, reference kept | ALTERED_OPINION_CHANGED |
  | Opinion type flipped to Qualified, reference kept | ALTERED_OPINION_CHANGED |
  | Re-saved by qpdf | ALTERED_OPINION_APPEARS_UNCHANGED |
  | Printed to PDF by Chromium | NOT_REGISTERED (no reference) |
  | Appended incremental update (a "withdrawn" page) | ALTERED_OPINION_APPEARS_UNCHANGED |
  | White text hidden at the end of the opinion | ALTERED_OPINION_CHANGED |
  | XMP stripped (Info keeps the reference) | ALTERED_OPINION_APPEARS_UNCHANGED |
  | XMP and Info stripped | NOT_REGISTERED (no reference) |
  | Stamp forged to name another family's record | ALTERED_OPINION_CHANGED |
  | Stamp naming a record that does not exist | NOT_REGISTERED (names an unknown record) |
  | XMP alone forged, Info left | NOT_REGISTERED (reference unreadable) |

  Every APPEARS_UNCHANGED row is a file that is not the registered one, and
  the verdict says so: the appended "withdrawn" page is exactly why it must.
- **Privacy, resilience, accessibility**: Playwright captures every request
  during a verification (none carries the file; all go to the RPC endpoints),
  answers `/api/*` with 503 throughout, and runs axe (WCAG 2.2 AA) on
  `/verify` in both languages and themes, before and after a verdict, on the
  lookup page and on the single-file verifier.
- **CSP by nonce, in `src/proxy.ts`**, on `/verify` and `/r/*` only: Next.js's
  own inline scripts carry the per-request nonce, so no script runs without
  it; `connect-src` is the origin and the two endpoints. Inline styles stay
  allowed for the UI kit's positioned popovers. The signed-in app has no CSP
  yet (#84).
- **Rate limit**: the lookup page, which reads the chain on the server, takes
  60 requests a minute per client address and 600 in all; the per-address
  limit needs `TRUST_PROXY_HEADERS=1`, the total holds regardless. `/verify`
  needs no limit: its server does no work per verification.
- **Correction to 4a**: pdf.js 6 has no eval path at all, so the
  `isEvalSupported: false` added in 4a did nothing and is gone.
- **Found on the way: an approval could deadlock with any other audited write
  in the same firm.** The approval locked the firm's row `FOR UPDATE` and
  then asked for the firm's audit lock; every audited write holds the audit
  lock and then inserts an event whose foreign key takes a key-share lock on
  that row, which `FOR UPDATE` blocks. Postgres aborted one of the two
  (`40P01`), which surfaced once as a failed approval in the end-to-end run.
  The row is now locked `FOR NO KEY UPDATE`, which still serialises approvals
  against mode changes but not against foreign-key checks; a database test
  reproduces the interleaving.

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

- [x] Every mutating route checks role on the server; preparer ≠ approver is also a database constraint
- [x] Multi-factor sign-in is required for APPROVER and ADMIN
- [x] Sign-in and mutations are rate-limited, with lockout after repeated failures
- [x] Notification emails carry no PDF, no opinion text and no figures
- [x] The nightly audit-chain check alerts on any break
- [x] Database and encrypted file store are backed up, and one restore has been tested

**As built: Phase 5 ships in five pull requests.** 5a is roles, two-step
sign-in and the rate limits (#52, #58). Departures from the prompt below, and
decisions it left open:

- **Roles live on the user**, not on a Membership: there is one firm (#5), so
  a user has one role in it. The table of acts is `src/lib/roles.ts`; the
  route handler refuses by it before any work, and the use cases check it
  again. An ADMIN may also change the write mode.
- **Two-step sign-in is part of the credentials sign-in.** The password is
  checked first; an approver or admin with TOTP on is then asked for a code or
  a recovery code in a second step, and one without it signs in only to set it
  up (`/account/mfa`, nothing else is allowed). Setting it up ends with signing
  in again, so the session is verified. A code is accepted for a time step
  later than the last accepted one, never twice.
- **The limits**: sign-in 10 attempts a minute per address, and lockout after
  5 failures per email or 10 per address within 15 minutes (the per-email
  limit is stricter than the prompt's 10 because the address is trusted only
  behind a proxy that sets it); writes 60 a minute per user.
- **Found on the way**: Next.js sets `X-Forwarded-For` itself, so with
  `TRUST_PROXY_HEADERS=1` the end-to-end suite was one address signing in a
  dozen times a minute and the new limit refused it; each test now signs in
  from its own address.

5b is the console's pages and dashboard (#53, #54):

- **The engagement page is the timeline.** The prompt's `/engagements/[id]`
  is the existing `/reports/[engagementId]`, so links already sent keep
  working; it now shows each version's status, reason, who prepared and
  approved it, block, transaction, record id (with copy buttons and explorer
  links on a public chain) and its download. The newest version with a final
  anchor is marked as the latest on chain. `/clients`, `/clients/[id]` and
  `/dashboard` are new; all signed-in pages share one layout with a nav.
- **TanStack Table 9.2.8**, the newest release more than two weeks old
  (upstream pins 9.3.1). The lists search, sort and page in the browser over
  rows the server scoped to the firm; the client list loads at most 1,000 and
  says when it was cut.
- **The charts are vendored** (`TimeSeriesChart`, `Bars`, the axes and what
  they import: eleven chart files and the date formatter), with their
  dependencies at upstream's versions.
  Each chart is followed by its figures as a table, and its bars stay still
  for a reader who asked for reduced motion.
- **Journal rows by status are a table, not a chart**: they are a snapshot by
  category, and the vendored chart draws series over dates. The tiles above
  it single out writes in flight and outcomes being settled.
- **Anchors per month** are writes whose block is final, read from the audit
  log's `anchor.final` and `anchor.linked` events by kind (originals, stamped
  copies, revocations).
- **Lookups per day** count visits to `/r/<familyId>/latest` for a family the
  firm issued: one row per firm and UTC day (`LookupCount`), written after the
  response so a database fault never costs the visitor their answer. Checks
  made with the verifier run in the visitor's browser (rule 5) and are not
  seen, so they are not counted.

5c is revocation (#55):

- **An admin asks, an approver approves.** The request carries a reason, a
  note (sealed, never on chain) and the engagement's reference typed out; the
  server checks the reference too. The approver is never the admin who asked:
  the roles differ, the use case checks it, and a CHECK in the database holds
  it. An approver can reject a request and the admin who made it can take it
  back; one request per version is open at a time (a partial unique index).
- **The typed confirmation sits in the form, not in the dialog.** The vendored
  ConfirmDialog renders its description inside a paragraph, which cannot hold
  inputs; the form's button stays disabled until the reference matches, and
  the ConfirmDialog then asks once more.
- **Reason codes** are fixed as the prompt gives them: WITHDRAWN 1,
  ISSUED_IN_ERROR 2, SUPERSEDED_AND_WITHDRAWN 3, OTHER 9.
- **The worker revokes the original's record**, through the journal like any
  write, and the version and the request are REVOKED only once that block is
  final. Revoking the original is enough: the verifier already reports a copy
  as revoked when its original is. A dry run simulates and returns the
  request for approval, as a dry-run anchor returns its version. A record
  already revoked with the same reason is linked and nothing is sent; one
  revoked with another reason is refused by name (`REVOKED_WITH_OTHER_REASON`).
- **A revocation waits for a stamped copy in flight** (`COPY_IN_FLIGHT`), so
  the copy's own checks never meet a revoked original halfway.
- **A version revoked after it was complete keeps its stamped PDF or
  certificate** for the firm's records; the timeline marks it revoked and any
  copy of it verifies as REVOKED.
- **The seed can turn the admin's two-step sign-in on too**
  (`SEED_ADMIN_TOTP_SECRET`, development and CI only), so the end-to-end test
  runs the whole flow with two people.

5d is the audit-log viewer, the nightly check and backups (#57, #59):

- **`/audit-log`** lists the firm's events newest first, 50 a page, and
  re-derives the whole chain on every view: intact with its head hash, or
  broken at a named event.
- **The nightly check does more than re-derive.** A chain whose tail was cut
  off, or whose history was rewritten and re-hashed by someone who controls
  the database, still verifies on its own. So each run is recorded and held
  to the last intact one: the chain may only have grown, and the event that
  was its head must still be there with the same hash (`TRUNCATED`,
  `REWRITTEN`). It exits 1 with an error line on a break, and a broken check
  puts a banner on every console page. A check older than 36 hours shows as
  stopped, so a check that silently stopped running is not mistaken for a
  clean one. Scheduling is the host's (cron); `docs/operations.md` gives the
  lines.
- **Backups**: a dump of the database and a copy of the store as it is on
  disk, with checksums. The encryption key is never in a backup. A restore
  goes only into an empty database and directory, and a separate check
  confirms the copy: migrations, every audit chain against the source, and
  every stored file decrypted against its SHA-256. CI runs the round trip,
  and the two refusals, after the end-to-end tests: that is the tested
  restore.

5e is recipients and the exit gate (#56, #60):

- **Recipients belong to the engagement**, not to a version: the prompt's
  "recipients of earlier versions" is everyone listed when a newer version
  becomes COMPLETE (a version 2 or later; an anchor-only version when its
  certificate is made). Someone added after that hears about the next one. A
  preparer or admin keeps the list, one live entry per address; removing
  someone keeps their row, so who was told what stays readable, and cancels
  anything not yet sent to them. Each recipient has a language, EN or BG.
- **What they are sent follows decision #8** (details only): the firm, the
  client, the engagement's reference, the period end, the new version's
  number, the link to `/r/<familyId>/latest` and the link to `/verify`. Plain
  text, no attachment: never the PDF, the opinion or a figure, and it says so.
  Every value from the database is kept on one line, so none can start a
  header or a paragraph.
- **An outbox, not a send in the transaction.** Completing a version queues
  a `Notification` per recipient in the same transaction, so a complete
  version and its notices exist together or not at all. The mailer
  (`npm run mailer`, its own process, holding no issuer key) sends at least
  once: it claims a notice under a lease, so one whose mailer died is sent
  again later; a duplicate notice is harmless and a lost one is not. After
  five failed attempts a notice is FAILED for a person to look at, and only a
  name for the error is kept, never what the server said, which can echo
  addresses.
- **The exit gate is the end-to-end flow**: a preparer issues version 1, a
  different approver approves it, version 2 supersedes it, both recipients
  (one EN, one BG) get one email each in Mailpit with no attachment and no
  opinion, the email's link shows version 2, an admin asks for version 1 to
  be revoked, an approver approves, and the verifier reports version 1's
  original and copy as REVOKED and version 2 as the latest. CI runs Mailpit
  as a service container.
- **Found on the way**: the version page said "Nothing has been anchored yet"
  under the commitments of a version long anchored; it now says what is on
  chain. And one test signing in as four people from one address tripped the
  sign-in limit, so each person in a test now signs in from an address of
  their own.

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

- [x] The threat model covers a forged issuer, key theft, a lying RPC endpoint, a chain reorg or sunset, PDF parser exploits and an insider reissuing a report
- [ ] Key ceremony and rotation runbook rehearsed; old records still verify after a rotation
- [ ] Monitoring and on-call for failed writes, finality lag, RPC disagreement, low balance and verifier errors
- [ ] `/verify` load-tested at 50 requests per second
- [ ] Disaster recovery restores the database and re-derives every verdict from the chain
- [ ] The re-anchoring proof verifies every Sepolia record against the production root

**As built so far.** 6a is the threat model, the runbooks and the owner's
script (#61, #67, #68):

- **`docs/threat-model.md`** goes through STRIDE for the contract, the worker
  and its key, the verifier, the console, the PDF pipeline, the mailer and the
  supply chain. Each threat names its mitigation and the test that proves it,
  or the issue that tracks it. Writing it found five gaps, filed as issues:
  - the worker trusts one RPC endpoint (#92, since built, 6g);
  - nothing detects writes the journal did not make (#93, since built as the
    registry watch, 6e);
  - a database owner can rewrite the audit log and its last check together
    (#94);
  - one stolen key can revoke every record for good, a decision before
    production (#95, since built as delayed revocation, 6d);
  - recipients are not told of a revocation (#96, since built, 6f).

  It also found cross-site write refusal untested, which now has a test over
  every route.
- **`docs/runbooks/`**: key rotation, the Safe, stuck writes, an RPC outage, a
  restore, mail, and the Sepolia sunset.
- **Key rotation is rehearsed on Anvil** by a worker test:
  - a new key continues the firm's families and the old key writes nothing
    more;
  - everything the old key anchored still verifies under the firm's name;
  - the new key revokes what the old one anchored.

  The rehearsal found that certificates were made only for versions the
  current key had anchored. Now any key's anchor-only version gets one. The
  hardening box stays open for the key ceremony, which arrives with KMS (#62).
- **`scripts/owner-call.ts`** prepares the owner's acts:
  - registering and retiring issuer keys;
  - offering ownership to a Safe;
  - the Safe's acceptance.

  It checks the registry, simulates, and prints the transaction. It never
  sends an ownership move.
- **The worker and the mailer ride out an outage.** A failed pass used to end
  the process: a minute of RPC trouble stopped anchoring until someone
  restarted it. Now a failed pass is tried again after the interval, and after
  20 in a row the process exits for its supervisor to restart.

6b is the issuer key in Cloud KMS (#62):

- **`SIGNER=kms`** makes the worker and the operator tools sign with a KMS key
  version (`KMS_KEY_NAME`), through `src/lib/chain/kms-account.ts`: a viem
  custom account.
  - **The digest.** KMS signs the 32-byte digest it is given, so the digest
    sent is Ethereum's keccak256 hash.
  - **The signature.** The DER it returns is read strictly, `s` is normalised
    to the low form, and the parity is found by recovering the key's own
    address.
  - **The checks.** Every CRC32C field KMS offers is checked, and so is the key
    version that signed. Any doubt is a named refusal, and nothing is sent.
  - **A raw `ISSUER_PRIVATE_KEY` left beside it is refused.**
- **Tested against a stand-in KMS** backed by a real key, which returns the
  high-s form on purpose:
  - every transaction, message and typed-data signature equals the key's own,
    byte for byte;
  - on Anvil, a version is anchored, copied and completed with exactly two KMS
    signatures;
  - a corrupted KMS answer sends nothing, and the write goes once KMS answers
    well.
- **`@google-cloud/kms` 6.2.1**, the newest release more than two weeks old,
  is loaded only when `SIGNER=kms`; its client fits the account's interface
  without a cast.
- **The key ceremony is `docs/runbooks/kms-key.md`**:
  - making an HSM key;
  - granting the worker sign and view rights on that key only;
  - logging every signature;
  - reading its address (`scripts/kms-address.ts`);
  - switching over as a key rotation.

  The owner performs it. Until then the hardening box for the key ceremony
  stays open.

6c is the production-chain options (#63). It stops for the owner's decision:

- **The four candidates and their testnets are one table** (`NETWORKS`):
  mainnet, Base, OP Mainnet and Arbitrum One, and Sepolia, Base Sepolia, OP
  Sepolia and Arbitrum Sepolia. Each reads `<NETWORK>_RPC_URL`, keeps its own
  deployment record, and has an explorer and a name. The worker, the verifier
  and every script take any of them.
- **The deploy script deploys to the testnets and refuses the production
  networks** by name until the owner chooses. It is tested on Anvil with Base
  Sepolia's chain id, and the adapter reaches finality there.
- **`docs/decision-production-chain.md`** compares the four:
  - cost per report, measured that day by `scripts/measure-chain-costs.ts`
    from each chain's fee history and the rollups' own L1-fee oracles;
  - finality lag, also measured;
  - who else each depends on, from L2BEAT;
  - explorers.

  It recommends Ethereum mainnet, with Merkle batching if volume makes cost
  matter: a mainnet record stays readable without anybody's continued service,
  and costs about EUR 0.04 a report today and EUR 1 to 17 at 1 to 20 gwei.
  Arbitrum One is the alternative if cost must be near zero.

6d is delayed revocation (#95). The owner chose it over the other options in
that issue: one issuer key may no longer withdraw a firm's records at once.

- **The contract.** An issuer key's `revoke` now only asks: the revocation
  takes effect `revocationDelay` seconds later, with no second transaction
  (`getRecord` computes `revoked` from the block's time). Until then only the
  owner's `cancelRevocation` undoes it; once in effect it is terminal. A record
  holds one revocation, so a second key cannot replace a genuine reason. The
  delay is set at deployment and kept in storage, so every deployment has the
  same bytecode; the deploy script defaults to 24 hours and refuses less than
  one off a local chain. Unit, fuzz and invariant tests cover the window; a
  revocation now writes a fresh slot (62,334 gas, was 42,294).
- **The worker.** A final REVOKE leaves its revocation SCHEDULED, with the time
  it takes effect. Each pass reads every scheduled one at the finalized block:
  in effect, the version and the revocation are REVOKED; gone, the owner
  cancelled it, and the revocation is CANCELLED while the version stands. The
  firm may then ask again.
- **The verifier** has a new verdict, REVOCATION_PENDING: the exact file, whose
  issuer has asked to withdraw it, with the time that takes effect. It is never
  called authentic. `/verify`, `verifier.html`, the CLI and
  `/r/<familyId>/latest` all show it.
- **The owner** cancels with `scripts/owner-call.ts cancel-revocation`;
  `docs/runbooks/stolen-issuer-key.md` says how to find revocations the firm
  did not ask for, and in what order to act.
- **What it does not do:** notice such a revocation. That is the registry
  watch, 6e (#93), without which the delay protects only those who look.

6e is the registry watch (#93), the detection half of a stolen key:

- **`npm run watch:registry`**, every ten minutes, reads every `Anchored` and
  `RevocationRequested` event by the firm's issuer keys up to the finalized
  block, and matches each to the journal by transaction hash. Every hash the
  app sends is journalled first (rule 3), a replaced one included, so a hash
  no row holds is a write the app did not make: a stolen key, or a row lost in
  a restore.
- **Each one is reported once**: an `UnjournaledWrite` row and an audit event,
  in the same transaction as the checkpoint, so a run that stops resumes where
  it stopped. A revocation is reported with the time it takes effect, which is
  the owner's deadline to cancel it.
- **It stays reported** until an admin marks it reviewed: a banner on every
  console page, the watch's card on `/audit-log`, and an error exit for the
  scheduler. A chain that does not hold the registry, or a firm the database
  does not hold under the deployment's name, is a refusal, never "nothing
  found".
- **CI runs it after the end-to-end tests**, which must leave nothing to
  report: every write they made went through the journal.

6f tells recipients when a version is withdrawn (#96):

- **When a revocation takes effect**, the worker queues a REVOKED notice per
  live recipient in the transaction that makes the version REVOKED. It queues
  nothing while the revocation is scheduled, nor when the owner cancels it:
  a recipient told of a withdrawal that never happened is misled.
- **The email** names the withdrawn version, the reason's fixed label (never
  the admin's sealed note), and the links to the latest record and to the
  verifier, in the recipient's language. No PDF, opinion or figure (#8).
- **`Notification.kind`** tells the two notices apart, so a recipient can be
  told both that version 2 supersedes theirs and that version 1 is withdrawn,
  each once. The recipients card says which was last sent.
- **Tested** by a worker test (scheduled, then cancelled, then in effect), a
  mailer test, email unit tests, and the end-to-end flow, which reads the
  withdrawal from Mailpit.

6g has the worker read two RPC endpoints, as the verifier does (#92):

- **A row is settled only on what both endpoints read** at one finalized
  block: the lower of the two, whose hash they must agree on. That covers a
  receipt, a record, the issuer's finalized nonce, and the events of a
  revocation's request or cancellation. A difference is `RPC_DISAGREE`: the
  row stays as it was and is compared again next pass. An endpoint that is
  merely behind is waited for, not called a liar.
- **A reverted transaction is judged at finality too**, on the agreed receipt:
  a revert in a block later reorged out could have been mined again.
- **The second endpoint is `<NETWORK>_RPC_URL_2`**, refused when missing,
  malformed or on the first one's host. A local chain may use one.
- **The console shows a banner** while the two disagree, with the time they
  first did (`IssuerKeyStatus.rpcDisagreedAt`); the first pass in which they
  agree clears it. `docs/runbooks/rpc-outage.md` says what to do.
- **Tested** with a second endpoint over the same Anvil that lies about a
  receipt, forgets a revocation, or lags; disabling the comparison fails the
  first two.

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
- [x] **Recipient access.** Decided 2026-10-25: details only. A recipient's link shows the latest version's number, date, block, transaction and status, and they ask the auditor for the PDF; there are no recipient accounts ([#8](https://github.com/h0mele55/hello-world/issues/8)). (Phase 5)

## Sources

- [Networks, ethereum.org](https://ethereum.org/en/developers/docs/networks/): Sepolia is "the recommended default testnet for application development"; Holesky deprecated as of September 2025.
- [Glamsterdam testnet announcement, Ethereum Foundation blog, 17 September 2026](https://blog.ethereum.org/2026/09/17/glamsterdam-testnet-announcement): Glamsterdam scheduled on Sepolia for 6 October 2026.
- [testnets-2026](https://github.com/dallaspu/testnets-2026): Sepolia for application development, Hoodi for validators.
- [docs/shared-ui-package-design.md](https://github.com/rodnapamet/inflect-compliance/blob/main/docs/shared-ui-package-design.md) and [packages/ui](https://github.com/rodnapamet/inflect-compliance/tree/main/packages/ui), inflect-compliance: how the package is consumed, and why npm cannot install it from git.
- npm registry, read 24 October 2026: [@cantoo/pdf-lib](https://www.npmjs.com/package/@cantoo/pdf-lib) 2.11.1 (15 September 2026); [pdf-lib](https://www.npmjs.com/package/pdf-lib) 1.17.1 (2022); [pdfjs-dist](https://www.npmjs.com/package/pdfjs-dist) 6.4.299; [viem](https://www.npmjs.com/package/viem) 2.57.11.
