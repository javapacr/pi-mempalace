# 008 — Decide whether to track user prompts absorbed by a nudge run

Status: open · P3

## Context

A real user prompt submitted while a nudge run streams is absorbed into that
run: it never fires its own `agent_settled` (the nudge run's settle is quiet)
and its `agent_end` is skipped by the pending-nudge flag — so it does not
advance `conversationCount` toward `save_interval`. The behavior is documented
in CONTEXT (nudge run) but untracked.

## Task

Decide whether this absorption matters enough to track (e.g. count absorbed
prompts separately, or release the pending flag when an interactive `input`
arrives mid-stream), then implement or close as wontfix.

## Acceptance

- A decision record exists here: either the tracking lands with a test, or the item closes with the reason.
- If implemented, `save_interval` curation cadence stays predictable from the user's point of view.
