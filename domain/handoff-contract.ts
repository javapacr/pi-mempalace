/**
 * pi-handoff shared-bus contract consumed by pi-mempalace (W1 channels, W2
 * payload docs and the command-start parser).
 *
 * The two repos share no types and pi-mempalace takes no dependency on
 * pi-handoff, so this module is the single mirror of the contract. Pinned
 * to pi-handoff 838ac31 (javapacr/pi-handoff#3, merged by PR
 * javapacr/pi-handoff#4): its `domain/types.ts`
 * (`HandoffToolEventPayload`, `HandoffCommandPayloadBase`,
 * `HandoffCommandStartPayload`, `HandoffCommandCompletePayload`) and README
 * "Lifecycle events". A rename or shape drift on the pi-handoff side
 * silently deafens these listeners or turns them inert (epic R2) — re-diff
 * this module against pi-handoff's `domain/types.ts` whenever pi-handoff
 * changes its contract.
 */

export const HANDOFF_CHANNELS = {
	toolStart: "handoff_tool_start",
	commandStart: "handoff_command_start",
	commandComplete: "handoff_command_complete",
	/** Legacy channel: the continue tool pre-filled the editor. */
	tuiFilledHandoff: "tui_filled_handoff",
} as const;

// ── Payload shapes (D6, mirrors of pi-handoff domain/types.ts) ───────────────

/**
 * Which command emitted a `handoff_command_*` event: `/handoff` or the
 * `/continue` command.
 */
export type HandoffTrigger = "handoff" | "continue";

/** Fields shared by every `handoff_command_start` / `handoff_command_complete`. */
export interface HandoffCommandPayloadBase {
	/** The goal for the handoff (null when inferred). */
	readonly goal: string | null;
	/** Legacy: mirrors `trigger === "continue"`; read `trigger` instead (E12). */
	readonly quickMode: boolean;
	/** Which command emitted the event. */
	readonly trigger: HandoffTrigger;
	/** Epoch ms timestamp. */
	readonly timestamp: number;
}

/**
 * Payload for `handoff_command_start`, emitted after pi-handoff's
 * has-conversation gate.
 */
export interface HandoffCommandStartPayload extends HandoffCommandPayloadBase {
	/** Only on `/handoff` start; call synchronously before your first await.
	 * Absent on bare `/continue` and on older pi-handoff installs. */
	readonly waitUntil?: (promise: Promise<unknown>) => void;
}

/** Payload for `handoff_tool_start`: the continue tool staged `/continue`. */
export interface HandoffToolStartPayload {
	/** The session title derived from the document's `## Next Task`. */
	readonly goal: string;
	/** The suggested command that was pre-filled. */
	readonly command: string;
	/** Epoch ms timestamp. */
	readonly timestamp: number;
}

/** Payload for `handoff_command_complete` — fires on every exit path (E10). */
export interface HandoffCommandCompletePayload
	extends HandoffCommandPayloadBase {
	/** Only on complete: the session title assigned. */
	readonly sessionTitle?: string;
	/** Only on complete: error message if the handoff failed. */
	readonly error?: string;
}

// ── Runtime guards (R2) ──────────────────────────────────────────────────────

/** The trusted result of parsing a `handoff_command_start` payload. */
export interface ParsedHandoffCommandStart {
	/** Exactly "handoff" or "continue"; null when missing or unknown (R2). */
	readonly trigger: HandoffTrigger | null;
	/** Registers a promise with pi-handoff's wait collector; null unless the
	 * payload carried a function `waitUntil` (D14). */
	readonly register: ((promise: Promise<void>) => void) | null;
}

/**
 * Runtime guard for a `handoff_command_start` payload (R2): the repos share
 * no types, so shapes are validated, never assumed. `trigger` is null unless
 * exactly "handoff" or "continue"; `register` is null unless `waitUntil` is
 * a function. Never throws — a malformed payload must not kill the emitter.
 */
export function parseHandoffCommandStart(
	data: unknown,
): ParsedHandoffCommandStart {
	const inert: ParsedHandoffCommandStart = { trigger: null, register: null };
	try {
		if (!data || typeof data !== "object") return inert;
		const payload = data as Partial<HandoffCommandStartPayload>;
		const trigger: HandoffTrigger | null =
			payload.trigger === "handoff" || payload.trigger === "continue"
				? payload.trigger
				: null;
		const register: ((promise: Promise<void>) => void) | null =
			typeof payload.waitUntil === "function"
				? (promise: Promise<void>) => {
						// Method call on the payload: a detached reference loses
						// `this` if pi-handoff implements the collector as a method.
						payload.waitUntil?.(promise);
					}
				: null;
		return { trigger, register };
	} catch {
		return inert;
	}
}
