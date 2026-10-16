/**
 * Unit tests for the settle-nudge activity threshold key (W3, D18):
 * `mempalace.diary_settle_min_tool_calls`.
 *
 * Same per-key merge contract as the other keys (settings-reader.test.ts):
 * default 3 when no file sets it, the project file wins over the profile
 * per key, and wrong-typed, negative or non-integer values fall through to
 * the other file, then to the default.
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
	scratch = await mkdtemp(join(tmpdir(), "settings-threshold-"));
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

describe("diary_settle_min_tool_calls (W3)", () => {
	it("defaults to 3 when no settings file sets the key", async () => {
		await writeProfileSettings({ diary_on_settle: true }); // other keys must not leak a threshold

		const s = await readMempalaceSettings(projectCwd());

		assert.equal(
			s.diarySettleMinToolCalls,
			DEFAULT_MEMPALACE_SETTINGS.diarySettleMinToolCalls,
		);
		assert.equal(s.diarySettleMinToolCalls, 3);
	});

	it("project wins over the profile per key", async () => {
		await writeProfileSettings({ diary_settle_min_tool_calls: 5 });
		await writeProjectSettings({ diary_settle_min_tool_calls: 1 });

		const s = await readMempalaceSettings(projectCwd());

		assert.equal(s.diarySettleMinToolCalls, 1, "project value wins");
	});

	it("wrong-typed, negative and non-integer values fall through", async () => {
		// Project garbage falls through to a valid profile value.
		await writeProfileSettings({ diary_settle_min_tool_calls: 7 });
		for (const bad of ["3", 1.5, -1, true, null]) {
			await writeProjectSettings({ diary_settle_min_tool_calls: bad });
			const s = await readMempalaceSettings(projectCwd());
			assert.equal(
				s.diarySettleMinToolCalls,
				7,
				`${JSON.stringify(bad)} must fall through to the profile`,
			);
		}

		// Garbage everywhere falls through to the default.
		await writeProfileSettings({ diary_settle_min_tool_calls: -3 });
		const s = await readMempalaceSettings(projectCwd());
		assert.equal(
			s.diarySettleMinToolCalls,
			DEFAULT_MEMPALACE_SETTINGS.diarySettleMinToolCalls,
			"a negative profile value must fall through to the default",
		);
	});
});
