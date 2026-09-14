/**
 * Settings.json reader for the mempalace extension.
 *
 * Reads the `mempalace` block from pi settings, merging two files PER KEY:
 *   1. project — <cwd>/.pi/settings.json (wins per key)
 *   2. profile — $PI_CODING_AGENT_DIR/settings.json (a relative env value
 *      resolves against ~/.pi); env unset → ~/.pi/agent/settings.json
 *
 * The pi ExtensionAPI does not expose a typed settings getter (verified from
 * @earendil-works/pi-coding-agent types), so we fall back to direct fs read.
 * Top-level camelCase key per pi convention (lifecycleReminders,
 * evidenceReceipt); ours is mempalace.
 *
 * Never throws: a missing/unreadable/malformed file contributes nothing, and
 * a wrong-typed value falls through to the other file, then to
 * DEFAULT_MEMPALACE_SETTINGS ("" palace counts as unset; save_interval must
 * be a positive integer; boolean keys must be booleans).
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
	DEFAULT_MEMPALACE_SETTINGS,
	type MempalaceChildrenSettings,
	type MempalaceSettings,
} from "../domain/types";

/**
 * Per-file parse result: a key is present only when valid in that file, so
 * `??` merging below implements both precedence and per-key fallback.
 */
interface ParsedSettingsFile {
	palace?: string;
	saveInterval?: number;
	recallOnPrompt?: boolean;
	children?: Partial<MempalaceChildrenSettings>;
}

/** Profile settings path: PI_CODING_AGENT_DIR (absolute or ~/.pi-relative), else the agent default. */
function profileSettingsPath(): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR;
	if (agentDir) {
		return isAbsolute(agentDir)
			? join(agentDir, "settings.json")
			: join(homedir(), ".pi", agentDir, "settings.json");
	}
	return join(homedir(), ".pi", "agent", "settings.json");
}

/**
 * Read one settings file into its top-level object.
 * Returns null when missing, unreadable, malformed, or not a JSON object —
 * expected failure modes (absent file, user edit), so no log either.
 */
async function readSettingsBlock(
	path: string,
): Promise<Record<string, unknown> | null> {
	try {
		const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return null;
		}
		return parsed as Record<string, unknown>;
	} catch {
		return null;
	}
}

/** Extract only the well-typed `mempalace` keys of one file (per-key defaults applied at merge). */
function parseSettingsFile(
	block: Record<string, unknown> | null,
): ParsedSettingsFile {
	const mempalace = block?.mempalace;
	if (!mempalace || typeof mempalace !== "object" || Array.isArray(mempalace)) {
		return {};
	}
	const m = mempalace as Record<string, unknown>;
	const parsed: ParsedSettingsFile = {
		// ""/whitespace counts as unset — it must never contribute a value.
		palace:
			typeof m.palace === "string" && m.palace.trim() ? m.palace : undefined,
		saveInterval:
			typeof m.save_interval === "number" &&
			Number.isInteger(m.save_interval) &&
			m.save_interval > 0
				? m.save_interval
				: undefined,
		recallOnPrompt:
			typeof m.recall_on_prompt === "boolean" ? m.recall_on_prompt : undefined,
	};
	const children = m.children;
	if (children && typeof children === "object" && !Array.isArray(children)) {
		const c = children as Record<string, unknown>;
		parsed.children = {
			recall: typeof c.recall === "boolean" ? c.recall : undefined,
			curation: typeof c.curation === "boolean" ? c.curation : undefined,
		};
	}
	return parsed;
}

/**
 * Read mempalace settings, project `<cwd>/.pi/settings.json` merged over the
 * profile file per key, defaults filling every gap.
 *
 * @param cwd - Project dir for the `<cwd>/.pi/settings.json` leg; omit to
 *              read the profile file only
 * @returns Fully-defaulted settings; never throws
 */
export async function readMempalaceSettings(
	cwd?: string,
): Promise<MempalaceSettings> {
	const project = parseSettingsFile(
		cwd ? await readSettingsBlock(join(cwd, ".pi", "settings.json")) : null,
	);
	const user = parseSettingsFile(await readSettingsBlock(profileSettingsPath()));
	const defaults = DEFAULT_MEMPALACE_SETTINGS;

	return {
		palace: project.palace ?? user.palace,
		saveInterval:
			project.saveInterval ?? user.saveInterval ?? defaults.saveInterval,
		recallOnPrompt:
			project.recallOnPrompt ?? user.recallOnPrompt ?? defaults.recallOnPrompt,
		children: {
			recall:
				project.children?.recall ??
				user.children?.recall ??
				defaults.children.recall,
			curation:
				project.children?.curation ??
				user.children?.curation ??
				defaults.children.curation,
		},
	};
}
