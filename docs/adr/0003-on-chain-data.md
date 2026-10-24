# 0003 — Only commitments go on chain

Status: accepted, 2026-10-24.

## Decision

The chain holds 32-byte values only: the file hash, a salted manifest hash, a
salted opinion commitment, a pseudonymous family id (an HMAC under the
issuer's secret), version and parent. Never a client name, opinion type or any
report text.

## Why

A public chain is permanent and readable by anyone, and who audits whom is
confidential. An unsalted hash of a short or boilerplate text (an opinion
paragraph) can be confirmed by guessing; a salt stops that.

## Consequences

Holders of the stamped PDF get the opinion salt inside its metadata, so they
can check the opinion; outsiders reading the chain learn nothing. Deleting the
off-chain salt and manifest makes an on-chain commitment unlinkable, which
matters for GDPR (Phase 6).
