/**
 * Subagent-child wake-up gate (PRD §4 Feature A).
 *
 * Decides — purely, from an env snapshot — whether this process is a pi
 * subagent child that must skip the MemPalace wake-up fetch/injection and
 * the session_start side effects (skill sync, MCP ensure).
 *
 * Contract: `PI_SUBAGENT_CHILD === "1"` is set by pi-subagents for ALL
 * children, fresh and fork (upstream `src/runs/shared/pi-args.ts`,
 * `env[SUBAGENT_CHILD_ENV] = "1"`). Children are task-focused and billed at
 * the tail of their parent's prompt — the ~914-token wake-up block and the
 * skill/MCP side-effect races are pure per-child waste there, and
 * `session_shutdown` transcript mining must keep working (config stays
 * resolved regardless of this gate).
 *
 * Never factory-freeze the hatch: this function must be re-invoked with a
 * fresh env read at every event (PRD A3) so the escape hatch is a
 * per-event operational control, not a load-time constant.
 */

export type ChildWakeupGateReason =
	| "parent"
	| "child-gated"
	| "child-hatch-fleet"
	| "child-hatch-scoped"
	| "child-hatch-out-of-scope";

export interface ChildWakeupGate {
	/** True when `PI_SUBAGENT_CHILD === "1"` (exact match). */
	readonly isChild: boolean;
	/** True when wake-up fetch/injection must be skipped. */
	readonly skipWakeUp: boolean;
	/** True when an escape hatch re-enabled wake-up inside a child. */
	readonly hatchUsed: boolean;
	readonly reason: ChildWakeupGateReason;
}

/** Split the hatch's agent csv: comma-separated, trimmed, empty tokens dropped. */
function parseAgentCsv(raw: string | undefined): string[] {
	return (raw ?? "")
		.split(",")
		.map((token) => token.trim())
		.filter((token) => token.length > 0);
}

/**
 * Resolve the child wake-up gate from an env snapshot.
 *
 * Rules (exact `=== "1"` semantics throughout):
 *  - Not a child → parent path, nothing gated.
 *  - Child without the hatch → wake-up gated.
 *  - Child + `PI_MEMPALACE_CHILD_WAKEUP=1`:
 *      - no `PI_MEMPALACE_CHILD_WAKEUP_AGENTS` csv → hatch applies (fleet).
 *      - csv set and `PI_SUBAGENT_CHILD_AGENT` matches a token → hatch
 *        applies (scoped), so one shell-exported flag cannot silently
 *        revert the whole fleet.
 *      - csv set and agent unset/non-matching → stays gated.
 */
export function resolveChildWakeupGate(
	env: Record<string, string | undefined>,
): ChildWakeupGate {
	const isChild = env.PI_SUBAGENT_CHILD === "1";
	if (!isChild) {
		return {
			isChild: false,
			skipWakeUp: false,
			hatchUsed: false,
			reason: "parent",
		};
	}

	const hatchOn = env.PI_MEMPALACE_CHILD_WAKEUP === "1";
	if (!hatchOn) {
		return {
			isChild: true,
			skipWakeUp: true,
			hatchUsed: false,
			reason: "child-gated",
		};
	}

	const allowed = parseAgentCsv(env.PI_MEMPALACE_CHILD_WAKEUP_AGENTS);
	if (allowed.length === 0) {
		return {
			isChild: true,
			skipWakeUp: false,
			hatchUsed: true,
			reason: "child-hatch-fleet",
		};
	}

	const agent = env.PI_SUBAGENT_CHILD_AGENT;
	const inScope = agent !== undefined && allowed.includes(agent);
	return inScope
		? {
				isChild: true,
				skipWakeUp: false,
				hatchUsed: true,
				reason: "child-hatch-scoped",
			}
		: {
				isChild: true,
				skipWakeUp: true,
				hatchUsed: false,
				reason: "child-hatch-out-of-scope",
			};
}
