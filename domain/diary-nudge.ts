/**
 * Settle diary nudge: gate, diary-tool matching, and message text (W1).
 *
 * Pure decision logic — no pi or infrastructure imports — so the gate is
 * unit-testable without a fake pi (D12). The nudge asks for exactly one
 * MemPalace diary entry per settled run when something durable happened,
 * a one-line skip otherwise, and never new work.
 */

/**
 * Every MemPalace diary-write tool name ends with this suffix, whatever the
 * MCP server prefixes (this profile registers
 * `mempalace-personal_mempalace_diary_write`). Matching by suffix is what
 * keeps the gate alive across palaces — pi-handoff's old exact-name reminder
 * never fired here (E8).
 */
export const DIARY_TOOL_SUFFIX = "mempalace_diary_write";

/** True when a registered tool name matches the diary-write suffix. */
export function isDiaryToolName(toolName: string): boolean {
	return toolName.endsWith(DIARY_TOOL_SUFFIX);
}

/** Shape of one `getAllTools()` entry; `getActiveTools()` returns bare names. */
export interface NamedTool {
	readonly name: string;
}

/**
 * True when a diary-write tool is registered, searching the active tools and
 * the full registry (active ∪ all): a registered-but-inactive tool still
 * proves the palace is wired for diary writes.
 */
export function hasDiaryTool(
	activeTools: ReadonlyArray<string>,
	allTools: ReadonlyArray<NamedTool>,
): boolean {
	return (
		activeTools.some((name) => isDiaryToolName(name)) ||
		allTools.some((tool) => isDiaryToolName(tool.name))
	);
}

/** Inputs to the settle gate, gathered by the agent_settled handler (D3/D4/D8/D10/D11). */
export interface SettleNudgeInput {
	/** pi ≥ 1.1 delivers `aborted` on agent_settled; absent reads as false (D10). */
	readonly aborted: boolean;
	/** pi run mode; only interactive TUI may nudge (D4). */
	readonly mode: string;
	/** Subagent children never nudge. */
	readonly isChild: boolean;
	/** `mempalace.diary_on_settle` (default true). */
	readonly enabled: boolean;
	/** A pi-handoff continue is under way (D8/D9). */
	readonly handoffInProgress: boolean;
	/** The settle belongs to the nudge's own run (D11/R7). */
	readonly nudgeRun: boolean;
	/** The run already wrote a diary entry. */
	readonly diaryWrittenThisRun: boolean;
	/** A `*mempalace_diary_write` tool is registered (D3/R3). */
	readonly diaryToolRegistered: boolean;
}

/**
 * The settle gate: nudge only a real, primary, enabled TUI run with a diary
 * tool available, that has not already diarised, is not the nudge's own run,
 * and is not inside a handoff (I1 gate list).
 */
export function shouldNudgeOnSettle(input: SettleNudgeInput): boolean {
	return (
		input.mode === "tui" &&
		input.enabled &&
		input.diaryToolRegistered &&
		!input.aborted &&
		!input.isChild &&
		!input.handoffInProgress &&
		!input.nudgeRun &&
		!input.diaryWrittenThisRun
	);
}

/** customType of the hidden settle nudge (D16). */
export const SETTLE_NUDGE_CUSTOM_TYPE = "mempalace-diary-settle";

/** Settle nudge text (D16, used verbatim). */
export const SETTLE_NUDGE_TEXT =
	"[MemPalace diary check] This run has settled. If it produced anything durable — a decision, a discovery, a fix, a user preference — write one MemPalace diary entry now with the diary-write tool. If nothing is durable, or a diary entry for this work already exists, reply with one short line and stop. Start no new work.";
