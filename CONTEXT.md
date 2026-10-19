# pi-mempalace

Session-lifecycle extension for pi: palace-aware recall, wake-up injection, curation, transcript mining. Architecture terms live in [README.md](README.md); the `request-attention` contract in [docs/attention.md](docs/attention.md).

## Language

**`request-attention`**:
Shared-bus event pi-claude-sandbox emits just before its interactive sandbox-permission prompt.
_Avoid_: sandbox alert, attention request

**attention payload**:
The `{ message: string }` carried by `request-attention`; malformed payloads resolve to the default message.
_Avoid_: event data, attention body

**transient toast**:
A `ctx.ui.notify` notification that clears itself — the chosen surface for `request-attention` (ADR-0001).
_Avoid_: banner, status line (both imply persistence)

**uiNotify capture**:
The notify capability bound at `session_start`, before any early return, so every mode can deliver toasts later.
_Avoid_: notify handle, ui context

**clear event**:
The upstream release signal that would end a persistent attention surface; pi-claude-sandbox emits none today.
_Avoid_: dismiss event, release event

**settle nudge**:
The hidden custom message (`mempalace-diary-settle`) sent after every qualifying settled TUI run, asking for one diary entry if anything durable happened, a one-line skip otherwise, and no new work; it yields when that run's `agent_end` just queued the curation checkpoint, whose own prompt already asks for a diary write.
_Avoid_: settle prompt, diary reminder (pi-handoff's removed feature), autosave (the curation checkpoint's customType)

**nudge run**:
The agent run a settle nudge starts via its `triggerTurn` delivery; it never advances the conversation count and never nudges again. A real user prompt submitted while it streams is absorbed into it — uncounted toward `save_interval`, and its settle sends no nudge.
_Avoid_: follow-up run, self run, diary turn (that is the handoff nudge's run, W2)

**pending-nudge flag**:
The `SessionState` flag set when a settle nudge starts its own run; `agent_end` only reads it, `agent_settled` reads and clears it — clearing at `agent_end` would loop the nudge onto its own settle.
_Avoid_: pending flag, nudge flag, nudge-pending state

**handoff-in-progress flag**:
The `SessionState` flag raised by pi-handoff's bus events (`handoff_command_start` with `trigger:"handoff"`, `handoff_tool_start`, `tui_filled_handoff`) and cleared by `handoff_command_complete`, the next interactive input, or the `session_start` reset; it silences the settle nudge while a handoff is under way.
_Avoid_: handoff state, handoff lock, handoff mode

**handoff nudge**:
The hidden custom message (`mempalace-diary-handoff`) sent when pi-handoff stages a handoff — from `/handoff`'s `handoff_command_start` (only `trigger:"handoff"`, with a registered settle waiter, past the handoff cost gate) or the continue tool's `handoff_tool_start` (deduped per session) — asking for one diary entry before the snapshot, a one-line skip otherwise, no new work, and never a second `continue`.
_Avoid_: handoff prompt, pre-handoff reminder (pi-handoff's removed diary reminder)

**settle waiter**:
One of the resolvers collected from `/handoff`'s `waitUntil`; `agent_settled`, `session_start` and `session_shutdown` release them, so the next settle — aborted or not — unblocks pi-handoff, whose own 120s deadline stays the only clock.
_Avoid_: wait promise, handoff timer, waitUntil handle

**handoff contract**:
The pi-handoff event shapes pi-mempalace mirrors in `domain/handoff-contract.ts`, comment-pinned to pi-handoff e711e2b (contract from 838ac31): the channel names, the `handoff_command_start`/`handoff_tool_start`/`handoff_command_complete` payloads with their `trigger`, and the synchronous `waitUntil` registration rule.
_Avoid_: event schema, sibling API, D6 shapes (the decision, not the thing)

**activity threshold**:
The minimum number of tool calls that must accumulate since the last diary write or diary nudge before a settle may nudge — `mempalace.diary_settle_min_tool_calls`, default 3, 0 = every settle. Counted from `tool_execution_start` across runs, so short runs add up; reset by a diary-tool call, a sent settle or handoff nudge, a nudge run's settle, and a settle that queued the curation checkpoint.
_Avoid_: tool budget, cooldown

**wait self-bound**:
pi-mempalace's own 125s ceiling on a `/handoff` wait it registered: an unref'd timer that releases the settle waiters if no settle arrives. Defence in depth behind pi-handoff's 120s cap; cleared by every other release.
_Avoid_: handoff timeout (pi-handoff owns that)

**drift warning**:
The one-per-session notification raised when a `handoff_command_start` arrives in a shape pi-mempalace cannot act on (missing/unknown `trigger`, or `/handoff` without `waitUntil`), so a pi-handoff contract mismatch is visible instead of silently disabling the handoff nudge.
_Avoid_: version error, compat check

**handoff cost gate**:
The `/handoff`-only check that skips the handoff nudge (and its settle waiter) when the turn would be wasted spend: a cold prompt cache — the last clean assistant message started longer ago than `mempalace.diary_on_handoff_max_idle_ms` (unset → 4.5 min, or 55 min under `PI_CACHE_RETENTION=long`), or none yet — or nothing new to diarise (activity count 0 and no curation checkpoint queued). The continue-tool leg has none: it fires mid-run, on a warm cache.
_Avoid_: cache check, idle gate, TTL gate

**checkpoint-variant nudge**:
The handoff nudge text used when a curation checkpoint is still queued (pending from the `agent_end` that queued it until the next `agent_start`): it asks the agent to finish that checkpoint concisely — it includes the diary write — and then stop.
_Avoid_: combined prompt, curation nudge

**diary tool**:
The MemPalace diary-write MCP tool, matched by the `mempalace_diary_write` name suffix across active and all registered tools; it must be registered directly — a tool reachable only through an MCP gateway leaves both nudges inert.
_Avoid_: exact tool-name match, diary-write gateway
