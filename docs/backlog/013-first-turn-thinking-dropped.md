# 013 — The first turn's thinking is dropped when a custom message sits before the initial system message

Status: open · P2 (pi core / pi-handoff) · found investigating the recall-stability question, 2026-11-07

## Context

In handoff session `2026-11-07T07-07-56-590Z_01a1b4d5-…jsonl`, every call
after the first reported `thinking_dropped` at `messages.4.content.0` with
`prefix_binding_mismatch`. That block is the first assistant turn's thinking.
The per-prompt `mempalace-recall` message was suspected. The evidence does not
support that.

Survey of the first two assistant turns in about 400 recent personal sessions.
"First-turn shape" is the entries before the first assistant message; "drop"
means the second call dropped the first turn's thinking:

| First-turn shape | drop | no drop |
| --- | --- | --- |
| `custom:handoff-origin system user cm:mempalace-recall` | 56 | 2 |
| `custom:handoff-origin system user` (no recall) | 2 | 0 |
| `cm:plan-approved-execute system user cm:mempalace-recall` | 4 | 0 |
| `system user cm:mempalace-recall` | 4 | 54 |
| `system user` (no recall) | 3 | 18 |

- Recall is not the trigger. 54 of 58 `system user recall` sessions kept
  their thinking. Handoff sessions without recall still dropped it.
- The drop follows a custom message persisted **before** the initial system
  message. pi-handoff writes `handoff-origin` in `newSession({ setup })`
  before the first prompt records the system message. `plan-approved-execute`
  has the same shape. On the first call, the system prompt goes out as the
  leading system prompt. On later calls, pi-ai rebuilds the transcript from
  the session, and the system message is no longer first. Mid-conversation
  system messages are held and emitted before the next assistant message, so
  the prefix the first thinking block was signed against changes. This is an
  inference from `pi-ai` `convertMessages` and `utils/transcript.ts`; no
  request payload diff has been captured.
- The rare drops with no leading custom message (7 of 79) are unexplained. One
  is session `01a1b4e5` on pi 1.5.0 / Pi-Bolt 1.1.3.

## What this repo did

The recall message is already stable. Its content is a pure function of the
snippets, `details` never reach the model, and
`tests/wake-up-message.test.ts` pins that a run's recall message and its
persisted replay convert to identical LLM messages.

The new wake-up message is returned from `before_agent_start`, **not** sent
at `session_start`. A `session_start` `sendMessage` would persist it before
the initial system message, which is exactly the shape that drops the first
turn's thinking.

## Task (upstream)

- pi-handoff: write `handoff-origin` after the first prompt's system message,
  or as a non-context custom entry (`appendEntry`) with the document in data.
  The same applies to any extension that persists a context message before
  the first prompt.
- pi core: alternatively, keep the initial system message leading when
  rebuilding the transcript, so a pre-prompt custom message cannot move it.
  Capture two consecutive request payloads (`before_provider_request`) to
  confirm the diverging block before filing.

## Acceptance

- A handoff session's second call reports no `thinking_dropped` for the first
  assistant turn, and its `cacheRead` covers the first call's full prefix.
