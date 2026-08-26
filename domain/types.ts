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

	reset(): void {
		this.wakeUpContext = null;
		this.wakeUpRetried = false;
		this.conversationCount = 0;
		this.config = null;
	}
}
