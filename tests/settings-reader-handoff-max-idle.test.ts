/**
 * Unit tests for the /handoff cold-cache limit key (D22):
 * `mempalace.diary_on_handoff_max_idle_ms`.
 *
 * Same per-key merge contract as the other keys (settings-reader.test.ts):
 * undefined when no file sets it (the gate then derives the limit from
 * PI_CACHE_RETENTION), the project file wins over the profile per key, and
 * wrong-typed, zero, negative or non-integer values fall through to the
 * other file, then to undefined.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readMempalaceSettings } from "../infrastructure/settings-reader";
import { DEFAULT_MEMPALACE_SETTINGS } from "../domain/types";

let scratch = "";
let savedHome = "";
let savedAgentDir: string | undefined;

async function writeJson(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, JSON.stringify(value, null, "\t"));
}

/** Write the project leg of the settings merge (<scratch>/project cwd). */
function writeProjectSettings(mempalace: unknown): Promise<void> {
	return writeJson(join(scratch, "project", ".pi", "settings.json"), {
		mempalace,
	});
}

/** Write the profile leg under the redirected HOME (~/.pi/agent/settings.json). */
function writeProfileSettings(mempalace: unknown): Promise<void> {
	return writeJson(join(scratch, "home", ".pi", "agent", "settings.json"), {
		mempalace,
	});
}

beforeEach(async () => {
	scratch = await mkdtemp(join(tmpdir(), "settings-max-idle-"));
	await mkdir(join(scratch, "project", ".pi"), { recursive: true });
	savedHome = process.env.HOME ?? "";
	savedAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.HOME = join(scratch, "home");
	delete process.env.PI_CODING_AGENT_DIR;
});

afterEach(async () => {
	if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
	process.env.HOME = savedHome;
	await rm(scratch, { recursive: true, force: true });
});

const projectCwd = () => join(scratch, "project");

describe("diary_on_handoff_max_idle_ms (D22)", () => {
	it("is undefined when no settings file sets the key", async () => {
		await writeProfileSettings({ diary_on_handoff: true }); // other keys must not leak a limit

		const s = await readMempalaceSettings(projectCwd());

		assert.equal(s.diaryOnHandoffMaxIdleMs, undefined);
		assert.equal(
			s.diaryOnHandoffMaxIdleMs,
			DEFAULT_MEMPALACE_SETTINGS.diaryOnHandoffMaxIdleMs,
		);
	});

	it("project wins over the profile per key", async () => {
		await writeProfileSettings({ diary_on_handoff_max_idle_ms: 600_000 });
		await writeProjectSettings({ diary_on_handoff_max_idle_ms: 120_000 });

		const s = await readMempalaceSettings(projectCwd());

		assert.equal(s.diaryOnHandoffMaxIdleMs, 120_000, "project value wins");
	});

	it("wrong-typed, zero, negative and non-integer values fall through", async () => {
		// Project garbage falls through to a valid profile value.
		await writeProfileSettings({ diary_on_handoff_max_idle_ms: 600_000 });
		for (const bad of ["60000", 1.5, 0, -1, true, null]) {
			await writeProjectSettings({ diary_on_handoff_max_idle_ms: bad });
			const s = await readMempalaceSettings(projectCwd());
			assert.equal(
				s.diaryOnHandoffMaxIdleMs,
				600_000,
				`${JSON.stringify(bad)} must fall through to the profile`,
			);
		}

		// Garbage everywhere falls through to undefined (derived default).
		await writeProfileSettings({ diary_on_handoff_max_idle_ms: 0 });
		const s = await readMempalaceSettings(projectCwd());
		assert.equal(
			s.diaryOnHandoffMaxIdleMs,
			undefined,
			"a zero profile value must fall through to the derived default",
		);
	});
});
