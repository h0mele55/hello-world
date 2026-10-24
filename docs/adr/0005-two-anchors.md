# 0005 — Two anchors per issue: the original, then the stamped copy

Status: accepted, 2026-10-24.

## Decision

Anchor the original PDF. Once its block is final, write chain id, contract,
record id, transaction hash, block number and the opinion salt into the PDF's
XMP and Info metadata, without touching page content. Anchor that stamped copy
as a DISTRIBUTION_COPY child of the original.

## Why

Writing the block into a PDF changes its hash, so the stamped file needs an
anchor of its own. With two anchors the verifier only ever compares whole-file
hashes.

## Rejected

One anchor plus an incremental-update stamp: saves a transaction, but the
verifier would have to prove the appended section touches only metadata. That
is the "shadow attack" surface PDF signatures suffer from.

## Consequences

Each issue costs two transactions (free on a testnet; cents on a production
rollup). Merkle batching in Phase 6 can reduce it.
