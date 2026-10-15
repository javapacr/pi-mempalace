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
The `SessionState` flag raised by pi-handoff's continue-path bus events (`handoff_tool_start`, `tui_filled_handoff`; `/handoff` in W2) and cleared by `handoff_command_complete`, the next interactive input, or the `session_start` reset; it silences the settle nudge while a handoff is under way.
_Avoid_: handoff state, handoff lock, handoff mode

**diary tool**:
The MemPalace diary-write MCP tool, matched by the `mempalace_diary_write` name suffix across active and all registered tools; it must be registered directly — a tool reachable only through an MCP gateway leaves both nudges inert.
_Avoid_: exact tool-name match, diary-write gateway
