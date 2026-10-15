# 006 — Live TUI smoke: settle nudge and pi-handoff continue path on pi 1.2.0

Status: open · P2

## Context

W1 was proven by unit tests and the fake-pi harness only. The installed pi is
1.2.0 and pi-handoff's continue/auto-submit path moves under it — neither has
been exercised end-to-end in a live TUI with the settle nudge attached.

## Task

In a live interactive TUI on pi 1.2.0 with the installed pi-handoff
(838ac31+): settle a real run and confirm the hidden nudge arrives and its own
run stays quiet; then drive a continue-tool handoff and confirm the settle
stays silent through `tui_filled_handoff` and the auto-submit Enter press.

## Acceptance

- A real TUI settle queues exactly one hidden nudge; the nudge run's settle sends nothing.
- A continue-tool handoff settles with no nudge between `tui_filled_handoff` and the auto-submit.
- `npm run typecheck` and `npm test` stay green.
