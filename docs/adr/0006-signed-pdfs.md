# 0006 — PDFs that are already signed are never rewritten

Status: accepted, 2026-10-24.

## Decision

A PDF carrying a digital signature (`/ByteRange`) is anchored as is, and the
issuer receives a separate one-page verification certificate instead of a
stamped copy.

## Why

Rewriting a signed PDF invalidates the auditor's PAdES or qualified signature,
which is worth more than the embedded link.

## Consequences

Signed reports carry no embedded reference, so an altered signed report reads
"not registered" rather than "altered" in the verifier. The certificate's QR
code takes the reader to the verifier.
