/**
 * Palace routing — resolves the active MemPalace config from the cwd.
 *
 * Priority order:
 *   1. `mempalace.yaml` in cwd  →  `palace_path`, `wing`, `rooms`
 *   2. cwd under CVP_ROOT       →  CVP_PALACE
 *   3. Default                  →  personal palace (env → settings → home-relative)
 *
 * The default leg now uses the env/settings/default chain from
 * resolvePersonalPalace (Aug 8 backlog resolution).
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import {
	CVP_PALACE,
	CVP_ROOT,
	type MempalaceConfig,
} from "./types";
import { resolvePersonalPalace } from "./palace-default";
// Pragmatic boundary: this module already reads mempalace.yaml from disk, so it
// also reads the user's settings.json for the personal-palace leg. Both are
// config-file I/O, and keeping them here means every caller gets the full
// env → settings → default chain without threading parameters.
import { readMempalaceSettings } from "../infrastructure/settings-reader";

interface MempalaceYaml {
	palace_path?: string;
	wing?: string;
	rooms?: Array<{ name: string } | string>;
}

function expandPath(p: string): string {
	if (p.startsWith("~/")) return join(homedir(), p.slice(2));
	if (p === "~") return homedir();
	return p;
}

function isCvpPath(cwd: string): boolean {
	return cwd === CVP_ROOT || cwd.startsWith(CVP_ROOT + "/");
}

/**
 * Resolve the active MemPalace config for a directory.
 *
 * @param cwd - Current working directory
 * @param overrides - Optional overrides for testing (env, settings, homeDir)
 * @returns Palace config with resolved path, wing, and rooms
 */
export async function resolveMempalaceConfig(
	cwd: string,
	overrides?: {
		envPalace?: string;
		settingsPalace?: string;
		homeDir?: string;
	},
): Promise<MempalaceConfig> {
	const homeDir = overrides?.homeDir ?? homedir();

	// Determine personal default using env → settings → default chain.
	// Key-presence check ("in") lets tests pin a leg to undefined; when a key
	// is absent, production reads env + settings.json.
	const envPalace =
		overrides && "envPalace" in overrides
			? overrides.envPalace
			: process.env.MEMPALACE_PALACE;
	const settingsPalace =
		overrides && "settingsPalace" in overrides
			? overrides.settingsPalace
			: (await readMempalaceSettings()).palace;
	const personalDefault = resolvePersonalPalace(
		envPalace,
		settingsPalace,
		homeDir,
	);

	let palace = isCvpPath(cwd) ? CVP_PALACE : personalDefault.path;
	let wing: string | null = null;
	let rooms: string[] = [];

	try {
		const content = await readFile(join(cwd, "mempalace.yaml"), "utf8");
		const parsed = YAML.parse(content) as MempalaceYaml | null;

		if (parsed?.palace_path) {
			palace = expandPath(parsed.palace_path);
		}
		if (parsed?.wing) {
			wing = String(parsed.wing).trim() || null;
		}
		if (Array.isArray(parsed?.rooms)) {
			rooms = parsed.rooms
				.map((r) => (typeof r === "string" ? r : (r?.name ?? "")))
				.filter(Boolean);
		}
	} catch {
		// No mempalace.yaml or parse error — fallback already applied above.
	}

	return { palace, wing, rooms };
}
