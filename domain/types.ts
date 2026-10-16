/**
 * MemPalace domain types and constants.
 *
 * Pure data shapes and shared constants. No infrastructure or pi dependencies.
 */

import { homedir } from "node:os";
import { join } from "node:path";

// ── Palace paths ──────────────────────────────────────────────────────────────

export const CVP_PALACE = join(homedir(), ".config", "mempalace", "cvp");
export const CVP_ROOT = join(homedir(), "Documents", "projects", "tml", "cvp");

// ── Recall tuning ─────────────────────────────────────────────────────────────

/** Minimum cosine similarity to surface a recall snippet. Override via env. */
export const SIMILARITY_THRESHOLD = parseFloat(
	process.env.MEMPALACE_RECALL_THRESHOLD ?? "0.60",
);
export const MAX_RESULTS = 3;
export const MAX_SNIPPET_LEN = 300;

// ── Session management ────────────────────────────────────────────────────────

/** Curate every N human exchanges (matches Claude Code hook SAVE_INTERVAL). */
export const SAVE_INTERVAL = 15;

// ── Settings contract ─────────────────────────────────────────────────────────

/** Child feature switches under `mempalace.children` in pi settings. */
export interface MempalaceChildrenSettings {
	/** Subagent children run the before_agent_start recall. Default false. */
	readonly recall: boolean;
	/** Subagent children run the agent_end curation checkpoint. Default false. */
	readonly curation: boolean;
}

/**
 * Parsed `mempalace` block from pi settings (project merged over profile).
 * Defaults are applied at parse time — absent/malformed keys never surface
 * here; precedence and validation live in infrastructure/settings-reader.ts.
 */
export interface MempalaceSettings {
	/** Personal palace override; undefined = unset (""/absent). */
	readonly palace: string | undefined;
	/** Exchanges between curation checkpoints. Positive int; default SAVE_INTERVAL. */
	readonly saveInterval: number;
	/** Master switch for before_agent_start recall; false disables it everywhere. Default true. */
	readonly recallOnPrompt: boolean;
	/** Settle diary nudge switch; false stops the after-run diary prompt. Default true. */
	readonly diaryOnSettle: boolean;
	/** Handoff diary nudge switch; false stops the before-snapshot diary prompt
	 * on both pi-handoff paths. Default true. */
	readonly diaryOnHandoff: boolean;
	/** Minimum tool calls a run must make before its settle nudge may fire
	 * (D18); non-negative integer, default 3; 0 restores every-settle. */
	readonly diarySettleMinToolCalls: number;
	/** Child feature gates. Both default false — primary-only by default. */
	readonly children: MempalaceChildrenSettings;
}

/** Per-key fallback applied when a settings key is absent or malformed. */
export const DEFAULT_MEMPALACE_SETTINGS: MempalaceSettings = {
	palace: undefined,
	saveInterval: SAVE_INTERVAL,
	recallOnPrompt: true,
	diaryOnSettle: true,
	diaryOnHandoff: true,
	diarySettleMinToolCalls: 3,
	children: { recall: false, curation: false },
};

// ── TUI ───────────────────────────────────────────────────────────────────────

export const RECALL_CUSTOM_TYPE = "mempalace-recall";

// ── Domain models ─────────────────────────────────────────────────────────────

export interface MempalaceConfig {
	palace: string;
	wing: string | null;
	rooms: string[];
}

export interface SearchResult {
	snippets: string[];
	wing: string | null;
	palace: string;
}

/**
 * Shared per-session mutable state.
 * Instantiated once in index.ts and injected into all handlers.
 */
export class SessionState {
	wakeUpContext: string | null = null;
	wakeUpRetried = false;
	conversationCount = 0;
	config: MempalaceConfig | null = null;
	/**
	 * Transcript file captured for THIS runtime (session_start/agent_end).
	 * Shutdown and compaction mining target this capture, not the live
	 * getSessionFile(): a same-manager fork flip can swap the session manager
	 * before the outgoing teardown runs, so the live getter may already expose
	 * the NEW branched file.
	 */
	sessionFile: string | null = null;
	/** One-shot child-gate log flags (PRD §4 A3/A6) — one line per session. */
	gateSkipLogged = false;
	hatchLogged = false;
	/** One-shot log flag: host lacks prompt sections (pi < 0.86). */
	noSectionsLogged = false;
	/**
	 * Settings parsed ONCE at session_start, BEFORE the print-mode and
	 * child-gate returns — children and print one-shots gate recall/curation
	 * on this snapshot. Null only before the first session_start.
	 */
	settings: MempalaceSettings | null = null;
	/**
	 * Set when a settle nudge starts its own run (D11). agent_end only reads
	 * it — clearing there would let the nudge re-nudge its own settle (R7);
	 * agent_settled reads and clears it.
	 */
	nudgeRunPending = false;
	/** The current run already called the diary-write tool; detected at
	 * tool_execution_start, cleared at settle (D11). */
	diaryWrittenThisRun = false;
	/** agent_end queued the curation checkpoint this run (D17): the checkpoint
	 * prompt already asks for a diary write, so the settle yields the nudge to
	 * it. Set on the checkpoint path, read-and-cleared at agent_settled. */
	checkpointQueuedThisRun = false;
	/** Tool calls accumulated since the last diary write or diary nudge (D18,
	 * amended): incremented by tool_execution_start and compared against
	 * diarySettleMinToolCalls at agent_settled. Survives a settle the gate
	 * skips for any other reason (below threshold, aborted, handoff window),
	 * so short runs add up. Reset to 0 by a diary-tool call, by the settle
	 * that sends the settle nudge, by the settle of a nudge run or of a run
	 * that queued the curation checkpoint, and by a handoff nudge. */
	toolCallsSinceDiary = 0;
	/** A curation checkpoint is queued and no run has started since (D21):
	 * set by the agent_end that queues it, cleared at the next agent_start
	 * (any run start drains the pending nextTurn message). Chooses the
	 * checkpoint-variant handoff nudge text; survives the settle that clears
	 * checkpointQueuedThisRun. */
	checkpointPending = false;
	/** One-shot drift warning flag (D20): pi-handoff sent a
	 * handoff_command_start this session could not act on; warn once, then
	 * stay silent. Cleared by reset() — the warning is per session. */
	handoffDriftWarned = false;
	/** A pi-handoff continue is under way (D8/D9): raised by its bus events,
	 * cleared by handoff_command_complete or the next interactive input. */
	handoffInProgress = false;
	/** A run is streaming (agent_start → agent_settled). Bus listeners get no
	 * ctx and extension commands can run mid-stream, so run activity is
	 * self-tracked (D13): a handoff nudge sets nudgeRunPending only when this
	 * is false, i.e. when it starts a run of its own. */
	agentRunActive = false;
	/** This session already sent the handoff_tool_start nudge (D6 dedupe):
	 * a repeated handoff_tool_start queues nothing more. Cleared only by
	 * reset() — a cancelled staged handoff earns no second nudge (D6/R9). */
	handoffToolNudged = false;
	/** Resolvers of the promises registered with pi-handoff's /handoff
	 * waitUntil (D15): agent_settled, session_start and session_shutdown
	 * release them, so pi-handoff never waits past the diary turn or teardown. */
	settleWaiters: Array<() => void> = [];
	/** Unref'd self-bound timer for the settle waiters (D19): releases them
	 * after HANDOFF_WAIT_SELF_BOUND_MS when no settle arrives. Cleared on
	 * every release path; null = no timer armed. */
	settleWaiterTimer: ReturnType<typeof setTimeout> | null = null;

	reset(): void {
		this.wakeUpContext = null;
		this.wakeUpRetried = false;
		this.conversationCount = 0;
		this.config = null;
		this.sessionFile = null;
		this.gateSkipLogged = false;
		this.hatchLogged = false;
		this.noSectionsLogged = false;
		this.settings = null;
		this.nudgeRunPending = false;
		this.diaryWrittenThisRun = false;
		this.toolCallsSinceDiary = 0;
		this.checkpointQueuedThisRun = false;
		this.checkpointPending = false;
		this.handoffDriftWarned = false;
		this.handoffInProgress = false;
		this.agentRunActive = false;
		this.handoffToolNudged = false;
		this.settleWaiters = [];
		// Clear the self-bound timer BEFORE nulling it (D19): a quitting pi
		// must not wait out the 125s on a reset that orphans the waiters.
		if (this.settleWaiterTimer !== null) {
			clearTimeout(this.settleWaiterTimer);
			this.settleWaiterTimer = null;
		}
	}
}
