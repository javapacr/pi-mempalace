/**
 * Personal palace path resolution — pure env → settings → default chain.
 *
 * No I/O or process.env reads at module level. All inputs passed as
 * parameters for testability. Matches the Aug 8 backlog requirement:
 * palace path comes from MEMPALACE_PALACE env → settings.json →
 * ~/.config/mempalace/palace (never a hardcoded absolute path).
 */

import { join } from "node:path";

/**
 * Source that resolved the palace path. Used for status reporting.
 */
export type PalacePathSource = "env" | "settings" | "default";

/**
 * Result of personal palace resolution.
 */
export interface ResolvedPersonalPalace {
	readonly path: string;
	readonly source: PalacePathSource;
}

/**
 * Resolve the personal MemPalace directory from env → settings → default.
 *
 * @param envPalace - Value of MEMPALACE_PALACE env var (trimmed, undefined if missing/empty)
 * @param settingsPalace - Value of mempalace.palace from settings.json (trimmed, undefined if missing/empty, may start with ~/)
 * @param homeDir - User home directory (for ~ expansion and default fallback)
 * @returns Resolved palace path with its source
 */
export function resolvePersonalPalace(
	envPalace: string | undefined,
	settingsPalace: string | undefined,
	homeDir: string,
): ResolvedPersonalPalace {
	// 1. Env var wins (if non-empty after trim)
	if (envPalace?.trim()) {
		return { path: envPalace.trim(), source: "env" };
	}

	// 2. Settings.json second (if non-empty after trim, with ~ expansion)
	const trimmedSettings = settingsPalace?.trim();
	if (trimmedSettings) {
		if (trimmedSettings.startsWith("~/")) {
			return { path: join(homeDir, trimmedSettings.slice(2)), source: "settings" };
		}
		if (trimmedSettings === "~") {
			return { path: homeDir, source: "settings" };
		}
		return { path: trimmedSettings, source: "settings" };
	}

	// 3. Default home-relative path
	return { path: join(homeDir, ".config", "mempalace", "palace"), source: "default" };
}
