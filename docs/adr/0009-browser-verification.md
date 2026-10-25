# 0009 — Verification happens in the reader's browser

Status: accepted, 2026-10-24.

## Decision

The verifier hashes the PDF with WebCrypto in the browser and reads the
contract directly from two public RPC endpoints, which must agree. The PDF is
never uploaded. A standalone HTML file and a CLI ship the same logic.

## Why

Audit reports are confidential, and a verifier that needs our server would
make our server a party everyone must trust.

## Consequences

The verifier must work with the app's server down (rule 5). Disagreeing RPC
endpoints give "cannot verify right now", never a verdict (rule 7).
