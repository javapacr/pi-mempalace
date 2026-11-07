/**
 * Pi transcript minability — does MemPalace parse this session as a pi
 * conversation, or would it ingest the raw JSONL?
 *
 * MemPalace core (normalize.py `_try_pi_jsonl`, v3.11.0) accepts a pi session
 * only when it has a `{"type":"session","version":…}` header AND at least two
 * user/assistant messages with non-empty text. Below that it returns None,
 * every other parser fails too, and `normalize` falls back to the RAW file
 * content: the whole JSONL — including pi's `role:"system"` entry with the
 * system-prompt sections and the `toolsAdded` tool JSON schemas — is chunked
 * into drawers. That is where tool-schema fragments in the L1 story come from
 * (short one-prompt sessions, print one-shots, tool-only runs). The real fix
 * belongs in core (docs/backlog/012); until then the extension does not hand
 * such a transcript to `mempalace mine`. A session that never reached two
 * text messages has no conversation worth mining.
 *
 * Mirrors core's text rule: user content as a string or text blocks;
 * assistant text blocks only (thinking and toolCall blocks carry no text).
 */

/** Messages core needs before it parses a pi session instead of raw-ingesting it. */
export const MIN_CONVERSATIONAL_MESSAGES = 2;

/** Non-empty text of a message content field, by core's `_extract_content` rule. */
function hasText(content: unknown): boolean {
	if (typeof content === "string") return content.trim().length > 0;
	if (Array.isArray(content)) {
		return content.some((item) => {
			if (typeof item === "string") return item.trim().length > 0;
			if (!item || typeof item !== "object") return false;
			const block = item as { type?: unknown; text?: unknown };
			return (
				block.type === "text" &&
				typeof block.text === "string" &&
				block.text.trim().length > 0
			);
		});
	}
	if (content && typeof content === "object") {
		const text = (content as { text?: unknown }).text;
		return typeof text === "string" && text.trim().length > 0;
	}
	return false;
}

/** What one parsed JSONL line contributes to minability. */
export type TranscriptLineKind = "header" | "conversational" | "other";

export function classifyTranscriptLine(entry: unknown): TranscriptLineKind {
	if (!entry || typeof entry !== "object") return "other";
	const e = entry as { type?: unknown; version?: unknown; message?: unknown };
	if (e.type === "session" && "version" in e) return "header";
	if (e.type !== "message" || !e.message || typeof e.message !== "object")
		return "other";
	const m = e.message as { role?: unknown; content?: unknown };
	if ((m.role === "user" || m.role === "assistant") && hasText(m.content))
		return "conversational";
	return "other";
}

/**
 * Incremental judge over JSONL lines: feed lines until `done`, then read
 * `minable`. Stops early once the header and enough messages are seen, so a
 * large transcript is never read in full.
 */
export class TranscriptMinability {
	private header = false;
	private messages = 0;

	/** Feed one raw JSONL line; malformed lines are ignored, as core does. */
	feed(line: string): void {
		const trimmed = line.trim();
		if (!trimmed) return;
		let entry: unknown;
		try {
			entry = JSON.parse(trimmed);
		} catch {
			return;
		}
		const kind = classifyTranscriptLine(entry);
		if (kind === "header") this.header = true;
		else if (kind === "conversational") this.messages++;
	}

	get minable(): boolean {
		return this.header && this.messages >= MIN_CONVERSATIONAL_MESSAGES;
	}

	get done(): boolean {
		return this.minable;
	}
}
