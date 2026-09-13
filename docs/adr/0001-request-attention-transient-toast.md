# Surface `request-attention` as a transient warning toast

Status: Accepted 2026-09-13

pi-claude-sandbox emits `request-attention` on pi's shared event bus immediately before its interactive sandbox-permission prompt (TUI runs only, `ctx.hasUI`) and sends no clear/release counterpart — so whatever surface a consumer picks must end on its own. We surface it as a transient `ctx.ui.notify(message, "warning")` toast, delivered through the notify capability captured at `session_start`. This is the established mechanism in this repo (skills-sync feedback) and the pattern pi's official event-bus example uses.

## Considered options

- **Persistent banner / status line** — removal requires a clear event; the emitter provides none, so the surface would persist forever.
- **OS-level notification** — side effects outside pi; `ctx.ui.notify` is the established in-pi channel.
- **Herdr intercom** — built for session-to-session messaging; this signal targets the user watching the current session.

## Consequences

- Lifecycle correctness rides entirely on the toast's self-clearing transience.
- An upstream clear event would reopen persistent attention surfaces — tracked in [../backlog/003-upstream-clear-event.md](../backlog/003-upstream-clear-event.md).
- The payload stays in-process: the parsed message goes to the toast and nowhere else.
