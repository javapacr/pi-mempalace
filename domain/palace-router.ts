/**
 * Palace routing — resolves the active MemPalace config from the cwd.
 *
 * Priority order:
 *   1. `mempalace.yaml` in cwd  →  `palace_path`, `wing`, `rooms`
 *   2. cwd under CVP_ROOT       →  CVP_PALACE
 *   3. Default                  →  PERSONAL_PALACE
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import {
	PERSONAL_PALACE,
	CVP_PALACE,
	CVP_ROOT,
	type MempalaceConfig,
} from "./types";

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

export async function resolveMempalaceConfig(
	cwd: string,
): Promise<MempalaceConfig> {
	let palace = isCvpPath(cwd) ? CVP_PALACE : PERSONAL_PALACE;
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
