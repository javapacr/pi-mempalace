# `request-attention` — sandbox-permission attention

Consolidated contract for the shared-bus listener. Everything about this feature lives here; the code owns in-file rationale comments, README owns the one-row summary, ADR-0001 owns the why.

## Event contract (emitter: pi-claude-sandbox)

- **Name:** `request-attention` on `pi.events` — the cross-extension bus, distinct from lifecycle `pi.on(...)` hooks.
- **Payload:** `{ message: string }`, currently `"Sandbox permission required"` (emitter source: `src/ui.ts:89`).
- **When emitted:** immediately before the emitter's interactive sandbox-permission prompt, and only when the emitter has a TUI (`ctx.hasUI`).
- **Clear event:** the emitter sends none. Consumers end their surface on their own — hence the transient toast (ADR-0001).

## Listener flow (this repo)

1. **Capture** — `session_start` assigns `uiNotify = ctx.ui.notify.bind(ctx.ui)` before both the print-mode early return and the child-gate early return, so every mode captures it → `infrastructure/event-registration.ts:registerMempalaceEvents`.
2. **Registration** — one `pi.events.on("request-attention", handler)` at extension-registration time; the handler is mode-agnostic.
3. **Delivery** — the handler parses the payload (`domain/attention.ts:parseRequestAttentionPayload`) and calls `uiNotify?.(message, "warning")`. Before any `session_start` the optional call is a safe no-op.

## Payload rules — `domain/attention.ts`

| Input | Result |
| --- | --- |
| Object with a non-empty string `message` | Preserved as-is; extra fields tolerated |
| Anything else — null, undefined, primitives, missing / empty / non-string `message` | `DEFAULT_ATTENTION_MESSAGE` = `"Sandbox permission required"` |

The parser always returns `{ message: string }` and never throws.

## Host guarantees (pi-coding-agent 0.84.2)

- `notify(message: string, type?: "info" | "warning" | "error"): void` — `core/extensions/types.d.ts:76`.
- The host auto-unsubscribes all `pi.events` listeners on runtime deactivation; extension reloads leak nothing.
- Headless runs receive a noOpUIContext, so `notify` there is a safe no-op.

## Test map — `tests/attention.test.ts`

| Rule pinned | Test |
| --- | --- |
| Payload truth table (valid, extras, malformed, shape, never-throws) | `parseRequestAttentionPayload` describe block (5 tests) |
| Exactly one listener registered on `pi.events` | "registers the listener and notifies via the session_start capture" |
| Capture happens before the print-mode early return | Same test — `session_start` driven with `mode: "print"` |
| Delivery with `"warning"` severity; malformed `null` → default message | Same test — two `fire(...)` assertions |
| Pre-`session_start` firing is a safe no-op | "firing before any session_start (nothing captured) is a safe no-op" |

`tests/child-gate.test.ts` gained harness-only stubs (`events.on`, `ctx.ui.notify`).

## Limitations

- Re-capture on a second `session_start` is a plain assignment with no test pinning it → [backlog/001](backlog/001-test-uinotify-recapture.md).
- Delivery is pinned in print mode only; the mechanism itself is mode-agnostic → [backlog/002](backlog/002-test-interactive-delivery.md).
- The upstream signal is TUI-only: headless pi-claude-sandbox runs emit nothing, so nothing arrives to surface.
