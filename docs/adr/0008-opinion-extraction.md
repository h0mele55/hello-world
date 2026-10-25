# 0008 — Heading search, then a person confirms the opinion

Status: accepted, 2026-10-24.

## Decision

A deterministic locator finds the opinion section by its ISA 700/705 heading
(English and Bulgarian) and takes the text up to the next "Basis for" heading.
The preparer confirms or corrects the text and the opinion type before
anything is committed.

## Why

The commitment is permanent. An automatic guess that was wrong would be
committed for good, and nobody would have looked at it.

## Rejected

Fully automatic or LLM extraction as the source of the committed text.

## Consequences

The verifier re-runs the same locator and normaliser on a non-identical file.
A match there is a signal, not proof (rule 4), because extracted text can
differ from what a PDF displays.
