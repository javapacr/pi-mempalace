/**
 * MemPalace skill sync domain logic — pure state machine.
 *
 * No filesystem or pi dependencies. Given bundled content and installed
 * path state, returns a plan of actions (INSTALL, REPLACE_SYMLINK, UPDATE,
 * NOOP) without executing any I/O.
 */

import { createHash } from "node:crypto";

export type SkillAction = "INSTALL" | "REPLACE_SYMLINK" | "UPDATE" | "NOOP";

export interface SkillPlan {
	readonly skillName: string;
	readonly action: SkillAction;
	readonly bundledHash: string;
	readonly installedHash: string | null;
	readonly reason: string;
}

export interface Marker {
	readonly managedBy: string;
	readonly skillHash: string;
	readonly syncedAt: string;
}

/** Marker file name written into each managed skill directory. */
export const MARKER_FILE = ".pi-mempalace.json";

/**
 * State of a skill installation directory (pure observation, no I/O).
 */
export interface SkillDirState {
	/** Does the directory exist? */
	readonly exists: boolean;
	/** Is it a symlink? (only meaningful when exists=true) */
	readonly isSymlink: boolean;
	/** SHA-256 hash of SKILL.md if readable, else null. */
	readonly skillHash: string | null;
	/** Marker content if present, else null. */
	readonly marker: Marker | null;
}

/**
 * Compute SHA-256 hash of a file's content (pure, no I/O).
 */
export function hashContent(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Parse marker JSON (pure, tolerant of malformed content).
 */
export function parseMarker(content: string): Marker | null {
	try {
		return JSON.parse(content) as Marker;
	} catch {
		return null;
	}
}

/**
 * Build a sync plan for a single skill (pure decision logic).
 *
 * Never throws — always returns a plan.
 */
export function buildSkillPlan(
	skillName: string,
	bundledContent: string,
	state: SkillDirState,
): SkillPlan {
	const bundledHash = hashContent(bundledContent);

	if (!state.exists) {
		return {
			skillName,
			action: "INSTALL",
			bundledHash,
			installedHash: null,
			reason: "Directory does not exist",
		};
	}

	if (state.isSymlink) {
		return {
			skillName,
			action: "REPLACE_SYMLINK",
			bundledHash,
			installedHash: state.skillHash ?? null,
			reason: "Existing installation is a symlink (npx skills)",
		};
	}

	// Real directory exists. Check staleness.
	const managedByExtension = state.marker?.managedBy === "pi-mempalace";
	const hashesMatch = state.skillHash === bundledHash;

	if (hashesMatch && managedByExtension) {
		return {
			skillName,
			action: "NOOP",
			bundledHash,
			installedHash: state.skillHash ?? null,
			reason: "Current and managed by pi-mempalace",
		};
	}

	if (!hashesMatch) {
		return {
			skillName,
			action: "UPDATE",
			bundledHash,
			installedHash: state.skillHash ?? null,
			reason: "Hash differs from bundled version",
		};
	}

	// Hashes match but not marked as managed — add marker only.
	return {
		skillName,
		action: "UPDATE", // Use UPDATE to write marker
		bundledHash,
		installedHash: state.skillHash ?? null,
		reason: "Current but not marked as managed",
	};
}