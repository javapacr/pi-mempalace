# 001 — Pin `uiNotify` re-capture on a second `session_start`

Status: open · P3

## Context

`registerMempalaceEvents` captures `uiNotify` by plain assignment inside `session_start` (`infrastructure/event-registration.ts`). A reviewer flagged that the re-capture path — a second `session_start` in the same runtime replacing the first binding — ships untested.

## Task

Add a wiring test in `tests/attention.test.ts`: drive `session_start` twice with two distinct `ctx.ui.notify` stubs, then fire `request-attention` and assert the second stub receives it.

## Acceptance

- The second fire reaches the second stub; the first stub receives nothing after re-capture.
- Suite and typecheck stay green.
