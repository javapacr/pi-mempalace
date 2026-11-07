# 012 — MemPalace core raw-ingests short pi transcripts, so tool schemas land in drawers

Status: open · P2 (MemPalace core) · extension guard shipped in `fix/wakeup-session-start-message`, 2026-11-07

## Context

The L1 "essential story" in the wake-up text showed fragments of tool JSON
schemas, such as `"member views."},"globs":{"type":"array"…`.

The cause is in MemPalace core 3.11.0, `normalize.py`:

- `_try_pi_jsonl` accepts a pi session only when it has a
  `{"type":"session","version":…}` header and at least two user/assistant
  messages with non-empty text. Thinking and `toolCall` blocks carry no text.
- Below that it returns `None`, and every other JSON parser fails too.
  `normalize` / `normalize_conversations` then fall back to the **raw file
  content**. Unlike the Codex `session_meta` case, nothing refuses this
  fallback.
- On pi ≥ 1.x the raw JSONL includes the `role:"system"` entry: system-prompt
  `sections` plus `toolsAdded`, the full tool JSON schemas. Those get chunked
  into drawers in the `sessions` wing and can rank into L1.

Evidence, 2026-11-07:

- `~/.pi/personal/sessions/--Users-reevonr-.pi-personal-tmp-perf--/2026-11-07T05-51-20-250Z_01a1b48f-…jsonl`
  has 1 user message and 4 assistant messages with no text. It normalizes to
  its raw JSONL and contains the `member views` schema text.
- 81 of the 1,308 top-level personal session files hit the raw fallback.
  They are short one-prompt runs, print one-shots, tool-only runs and perf
  probes.
- The other quoted L1 fragment ("List the exact names of every tool you
  have…", session `01a1b4bd`) is a real user prompt from a perf probe. It
  parses as pi, so it is ordinary conversation, not this bug.

## Shipped in the extension

`MiningUseCase` now skips any transcript core would raw-ingest
(`domain/pi-transcript.ts` + `infrastructure/transcript-probe.ts`). The rule
mirrors `_try_pi_jsonl`, and on all 1,308 sessions its verdict matched core's
with 0 mismatches. This stops new junk. It does not remove existing drawers,
and it does not protect other callers of `mempalace mine`.

## Task (MemPalace core)

- Make `normalize` / `normalize_conversations` refuse the raw-JSON fallback
  for a recognised pi session, as already done for Codex `session_meta`.
  Return no conversation, or a parse of whatever user/assistant text exists.
  Never return the raw file.
- Optionally skip `role:"system"` entries and `toolsAdded` explicitly in
  `_try_pi_jsonl`. They are already ignored today because only user and
  assistant roles are read.
- Palace cleanup (owner decision; it mutates the palace): find `sessions`-wing
  drawers whose text starts with `{"type":"session"` or contains
  `"toolsAdded"` / `"parameters":{"type":"object"`, then delete or re-mine
  them.

## Acceptance

- Core never stores raw pi JSONL in drawers: a regression test feeds a pi
  session with fewer than two text messages.
- After any cleanup, the wake-up L1 shows no tool-schema fragments.
- Once core ships the fix, the extension guard can stay as a cheap
  pre-check or be removed. Record the decision here.
