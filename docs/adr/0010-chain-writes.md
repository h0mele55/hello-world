# 0010 — Write ladder, journal before broadcast, four-eyes

Status: accepted, 2026-10-24.

## Decision

Chain writes follow the ladder Inflect uses for identity writes: DISABLED, then
DRY_RUN (simulate and record, never broadcast), then LIVE. A journal row in
state INTENT exists before every broadcast. An unknown outcome is
INDETERMINATE and settles by reading the chain. A second person approves every
anchor.

## Why

An anchor is public and permanent. A mistaken one can be revoked but never
removed, and a blind resend after a timeout can anchor twice.

## Rejected

Signing and sending directly from the request handler.

## Consequences

Phase 3 adds a worker, a nonce lock per issuer key, and reconciliation tests
that kill the worker mid-write.
