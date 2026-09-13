# 002 — Interactive-mode delivery test

Status: open · P3

## Context

The `request-attention` listener is mode-agnostic — the `uiNotify` capture precedes the print-mode early return — but `tests/attention.test.ts` pins delivery only through a print-mode `session_start`, chosen for hermeticity (no wake-up/skill-sync side effects).

## Task

Add an interactive-mode wiring test: drive `session_start` with `mode: "interactive"` (stub the wake-up and skill-sync legs) and assert the toast still delivers with `"warning"` severity.

## Acceptance

- Interactive-mode capture-and-deliver pinned alongside the print-mode test.
- Suite and typecheck stay green.
