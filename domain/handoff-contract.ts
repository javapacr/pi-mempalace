/**
 * pi-handoff shared-bus channel names consumed by pi-mempalace (W1).
 *
 * The two repos share no types and pi-mempalace takes no dependency on
 * pi-handoff, so this constant object is the single mirror of the channel
 * names. Pinned to installed pi-handoff 5e611aa (which emits
 * `tui_filled_handoff` and `handoff_command_complete` from its continue
 * tool) and to javapacr/pi-handoff#3, which adds `handoff_tool_start` and
 * `handoff_command_start{trigger,waitUntil}`. A rename on the pi-handoff
 * side silently deafens these listeners (epic R2) — W2's dry read re-diffs
 * this module against pi-handoff's `domain/types.ts`.
 */

export const HANDOFF_CHANNELS = {
	toolStart: "handoff_tool_start",
	commandStart: "handoff_command_start",
	commandComplete: "handoff_command_complete",
	tuiFilledHandoff: "tui_filled_handoff",
} as const;
