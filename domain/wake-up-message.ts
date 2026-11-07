/**
 * Wake-up as a conversation message — pure session-entry logic.
 *
 * The wake-up text (L0 identity + L1 essential story) is fetched ONCE, at the
 * start of a new session, and persisted in the conversation as a custom
 * message. It never lives in the system prompt: the L1 story changes as diary
 * entries land, and a system-prompt section re-fetched on every resume broke
 * the prompt-cache prefix and invalidated every earlier thinking block (the
 * 2026-11-07 cache-miss incident).
 *
 * The session entries are the only source of truth — no process-local flag
 * decides "already sent", so a restart, `--continue`, resume, reload or fork
 * finds the saved message and replays it exactly as before.
 *
 * No pi imports: entries are read structurally, so this module stays pure
 * and testable against plain objects.
 */

/** customType of the persisted wake-up message. */
export const WAKEUP_CUSTOM_TYPE = "mempalace-wakeup";

/**
 * Message content for a freshly fetched wake-up text. The frame tells the
 * model the block is background memory, not a user request — it arrives as a
 * user-role message, unlike the old system-prompt section. Applied once, at
 * fetch time: a saved message is replayed and re-appended verbatim.
 */
export function formatWakeUpMessage(text: string): string {
	return (
		"<mempalace-wakeup>\n" +
		"MemPalace wake-up context, loaded once at session start: who the user is " +
		"and the essential story so far. Background memory, not a request.\n\n" +
		`${text}\n` +
		"</mempalace-wakeup>"
	);
}

/** The structural slice of a pi session entry this module reads. */
export interface EntryLike {
	readonly type?: unknown;
	readonly customType?: unknown;
	readonly content?: unknown;
	readonly message?: unknown;
}

/** Text of a custom-message content field: a string, or its text blocks joined. */
function contentText(content: unknown): string | null {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return null;
	const parts: string[] = [];
	for (const block of content) {
		if (
			block &&
			typeof block === "object" &&
			(block as { type?: unknown }).type === "text" &&
			typeof (block as { text?: unknown }).text === "string"
		) {
			parts.push((block as { text: string }).text);
		}
	}
	return parts.length > 0 ? parts.join("\n") : null;
}

/**
 * The wake-up text an entry carries, or null when the entry is not a wake-up
 * message. Two persisted shapes: pi stores extension messages as
 * `custom_message` entries, while `sessionManager.appendMessage` callers
 * write a `message` entry with `role: "custom"` — both are read.
 */
export function wakeUpTextOf(entry: EntryLike | null | undefined): string | null {
	if (!entry || typeof entry !== "object") return null;
	if (entry.type === "custom_message" && entry.customType === WAKEUP_CUSTOM_TYPE)
		return contentText(entry.content);
	if (entry.type === "message" && entry.message && typeof entry.message === "object") {
		const m = entry.message as { role?: unknown; customType?: unknown; content?: unknown };
		if (m.role === "custom" && m.customType === WAKEUP_CUSTOM_TYPE)
			return contentText(m.content);
	}
	return null;
}

/**
 * The most recently saved wake-up text in the session, or null when none was
 * ever saved. Reads ALL entries, not just the current branch: a /tree move to
 * a point before the wake-up still reuses the saved text instead of fetching.
 */
export function findSavedWakeUp(entries: readonly EntryLike[]): string | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const text = wakeUpTextOf(entries[i]);
		if (text !== null && text.length > 0) return text;
	}
	return null;
}

/**
 * Whether the model context still needs a wake-up message, given the entries
 * that make up that context (pi's `sessionManager.buildContextEntries()`:
 * the current leaf's path, compaction-aware — the latest compaction entry,
 * the kept entries from its `firstKeptEntryId`, then everything after it).
 * True only when no wake-up message is among them: a new session, a
 * compaction that summarised the wake-up away, or a /tree move or fork to a
 * point before it. A wake-up kept in a compaction's tail is still in context,
 * so it is not appended a second time.
 */
export function contextNeedsWakeUp(contextEntries: readonly EntryLike[]): boolean {
	return !contextEntries.some((entry) => wakeUpTextOf(entry) !== null);
}
