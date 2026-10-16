# 010 — Idle `/handoff` nudge run drains a pending curation checkpoint

Status: done — W3 (#6) · was accepted risk W2.R2 (user 2026-10-15, issue #3)

## Context

`agent_end` queues the curation checkpoint as a hidden `nextTurn` message
(`infrastructure/event-registration.ts`, D17). If the user then types
`/handoff` while idle, the W2 handoff nudge starts its own run with
`triggerTurn:true`. On pi 1.2.0 that run drains the pending `nextTurn`
checkpoint into itself. This is the mirror image of D17, where the settle
nudge yields to a queued checkpoint. The handoff nudge does not yield.

The single run then holds two instructions: a full curation pass and "start
no new work". Curation can be long. pi-handoff's settle waiter only releases
on the next `agent_settled`, so the run could approach pi-handoff's 120s
`waitUntil` cap. After the cap, the handoff proceeds while curation is still
running, or the model skips curation because the nudge says to stop.

## Task

Decide how the `/handoff` leg treats a queued checkpoint. Options:

- Yield as D17 does: skip the handoff nudge while a checkpoint is pending,
  since the checkpoint prompt already asks for a diary write. Still register
  the settle waiter so the snapshot waits for the checkpoint run. This needs
  new state: `checkpointQueuedThisRun` is cleared at `agent_settled`, so by
  an idle `/handoff` nothing records that the checkpoint is still undelivered.
- Keep the current behaviour and document it in the handoff-contract section
  of README.
- Close as wontfix, with the reason recorded here.

## Acceptance

- The decision is recorded here. If code changes, a test pins the behaviour of
  an idle `/handoff` with a queued checkpoint.
- `npm run typecheck` and `npm test` stay green.

## Decision

2026-10-16 (user): combined nudge text. pi-mempalace tracks a pending
checkpoint (set by the `agent_end` that queues it, cleared at the next
`agent_start`); a `/handoff` while one is pending sends the
checkpoint-variant handoff nudge, which asks the agent to finish the
checkpoint concisely (it includes the diary write) and then stop. The
wait stays bounded by pi-handoff's 120s cap and pi-mempalace's 125s
self-bound. Pinned by the `H2 checkpoint:` tests.
