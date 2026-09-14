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
	/** Child feature gates. Both default false — primary-only by default. */
	readonly children: MempalaceChildrenSettings;
}

/** Per-key fallback applied when a settings key is absent or malformed. */
export const DEFAULT_MEMPALACE_SETTINGS: MempalaceSettings = {
	palace: undefined,
	saveInterval: SAVE_INTERVAL,
	recallOnPrompt: true,
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
	/**
	 * Settings parsed ONCE at session_start, BEFORE the print-mode and
	 * child-gate returns — children and print one-shots gate recall/curation
	 * on this snapshot. Null only before the first session_start.
	 */
	settings: MempalaceSettings | null = null;

	reset(): void {
		this.wakeUpContext = null;
		this.wakeUpRetried = false;
		this.conversationCount = 0;
		this.config = null;
		this.sessionFile = null;
		this.gateSkipLogged = false;
		this.hatchLogged = false;
		this.settings = null;
	}
}
