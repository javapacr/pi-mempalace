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
