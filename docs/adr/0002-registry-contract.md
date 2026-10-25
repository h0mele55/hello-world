# 0002 — A custom immutable registry contract, not EAS

Status: accepted, 2026-10-24.

## Decision

A small, immutable `AuditReportRegistry` contract with an issuer allowlist,
`anchor`, `anchorDistributionCopy`, `revoke`, and the reads
`recordOfDoc(hash)`, `latestOf(family)` and `getRecord(id)`. No proxy, no
`delegatecall`, no payable function.

## Why

"What is the latest version of this report?" must be answerable with one
contract read, so the verifier depends on nothing but the chain.

## Rejected

Ethereum Attestation Service: no contract to write and `refUID` can chain
versions, but "latest version" then needs an off-chain indexer, and the
verifier would trust that third party.

## Consequences

The contract needs its own tests (unit, fuzz, invariants), Slither, and in
Phase 6 an external review.
