/**
 * Sandbox-permission attention payload handling.
 *
 * pi-claude-sandbox emits a shared-bus `request-attention` event right
 * before showing its interactive permission prompt (TUI only) and
 * never sends a clear/release counterpart — consumers must surface it on
 * self-clearing UI only (transient toast), never sticky state.
 */

/** Message used when a `request-attention` payload carries no usable text. */
export const DEFAULT_ATTENTION_MESSAGE = "Sandbox permission required";

/**
 * Extract `{ message }` from a `request-attention` payload.
 *
 * A non-empty string `message` is returned as-is (extra fields tolerated);
 * anything else — null, undefined, primitives, missing/empty/non-string
 * `message` — falls back to `DEFAULT_ATTENTION_MESSAGE`. Never throws.
 */
export function parseRequestAttentionPayload(data: unknown): {
 message: string;
} {
 const message =
  typeof data === "object" && data !== null
   ? (data as { message?: unknown }).message
   : undefined;
 return {
  message:
   typeof message === "string" && message.length > 0
    ? message
    : DEFAULT_ATTENTION_MESSAGE,
 };
}
