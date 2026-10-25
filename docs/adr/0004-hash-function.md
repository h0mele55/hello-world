# 0004 — SHA-256 throughout

Status: accepted, 2026-10-24.

## Decision

Every commitment is SHA-256 (HMAC-SHA256 for the family id). The contract
stores `bytes32` values and never hashes them itself.

## Why

Browsers compute SHA-256 natively with WebCrypto, so the verifier needs no
cryptography library, and the same code runs in Node.

## Rejected

Keccak-256: native to Ethereum, but the browser verifier would need a library
for it, and the contract has no need to hash.

## Consequences

Record ids are still derived with keccak256 inside the contract; that is an
internal key, not a commitment anyone recomputes from a file.
