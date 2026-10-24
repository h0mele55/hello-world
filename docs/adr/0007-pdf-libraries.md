# 0007 — pdfjs-dist to read, @cantoo/pdf-lib to write

Status: accepted, 2026-10-24.

## Decision

`pdfjs-dist` (Apache-2.0) extracts text and metadata, on the server and in the
browser. `@cantoo/pdf-lib` (MIT, 2.11.1, updated September 2026) writes the
metadata stamp.

## Rejected

`pdf-lib`: the original library, last released in 2022.

## Consequences

Parsing untrusted PDFs is attack surface: Phase 2 runs the parser in a worker
thread with time and memory limits and fuzzes it with malformed files.
