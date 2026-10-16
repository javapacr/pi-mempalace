# 006 — Live TUI smoke on pi 1.3.0: settle nudge, /handoff wait, continue path, checkpoint variant

Status: open · P2 · blocks closing epic #1 (W3.R5 accepted only until this smoke runs)

## Context

W1 was proven by unit tests and the fake-pi harness only. The installed pi is
1.2.0 and pi-handoff's continue/auto-submit path moves under it — neither has
been exercised end-to-end in a live TUI with the settle nudge attached.

## Task

In a live interactive TUI on pi 1.2.0 with pi-handoff ≥ 838ac31
(pi-handoff#3; the installed store copy is 5e611aa today, so update it
first): settle a real run and confirm the hidden nudge arrives and its own
run stays quiet; then drive a continue-tool handoff and confirm the settle
stays silent through `tui_filled_handoff` and the auto-submit Enter press.

## Acceptance

- A real TUI settle queues exactly one hidden nudge; the nudge run's settle sends nothing.
- A continue-tool handoff settles with no nudge between `tui_filled_handoff` and the auto-submit.
- `npm run typecheck` and `npm test` stay green.

## W3 additions (2026-10-16)

Run this on pi 1.3.0, with the shared install at dc57f65 or later and
pi-handoff e711e2b:

- Threshold: a run with 1–2 tool calls settles quietly. A later run that
  brings the count since the last diary write or nudge to 3 or more gets the
  hidden nudge. A run that writes a diary entry starts the count over.
- `/handoff` wait: `/handoff` sends the hidden diary nudge. pi-handoff waits
  for that run to settle before it snapshots, and the wait never exceeds about
  120s; pi-mempalace's own release fires at 125s.
- Continue-tool path: the `continue` tool queues one diary nudge, and no
  settle nudge fires in the handoff window.
- Checkpoint variant: let `agent_end` queue the curation checkpoint (every 15
  exchanges, or a lower `save_interval`), then run an idle `/handoff`. Expect
  the checkpoint-variant text, and the checkpoint completes in that run.
- Save the evidence (session JSONL excerpts showing hidden customTypes
  `mempalace-diary-settle` / `mempalace-diary-handoff`) under
  `~/.pi/personal/tmp/w3-smoke/`.

