/**
 * Settings.json reader for mempalace extension.
 *
 * Reads the mempalace.palace configuration from ~/.pi/agent/settings.json.
 * The pi ExtensionAPI does not expose a typed settings getter (verified from
 * @earendil-works/pi-coding-agent types), so we fall back to direct fs read.
 *
 * This is the canonical way pi extensions read their settings: top-level
 * camelCase key (e.g., lifecycleReminders, evidenceReceipt). Ours is
 * mempalace.palace.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

/** Default path to pi's settings file. */
const SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");

/**
 * Settings shape as stored in settings.json.
 */
export interface MempalaceSettings {
	/** Optional override for the personal palace path. */
	readonly palace?: string;
}

/**
 * Read mempalace settings from ~/.pi/agent/settings.json.
 *
 * @returns Settings object, or empty object if file missing or malformed.
 */
export async function readMempalaceSettings(): Promise<MempalaceSettings> {
	try {
		const content = await readFile(SETTINGS_PATH, "utf8");
		const parsed = JSON.parse(content) as Record<string, unknown>;
		const mempalace = parsed.mempalace as Record<string, unknown> | undefined;

		return {
			palace: typeof mempalace?.palace === "string" ? mempalace.palace : undefined,
		};
	} catch {
		// File missing or parse error — no settings
		return {};
	}
}
