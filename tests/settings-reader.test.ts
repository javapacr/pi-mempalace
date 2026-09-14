/**
 * Unit tests for the mempalace settings reader (child-recall gating plan).
 *
 * Covers the per-key merge contract:
 *  - project <cwd>/.pi/settings.json wins per key over the profile file
 *  - profile path: PI_CODING_AGENT_DIR (absolute; relative resolves against
 *    ~/.pi); env unset → ~/.pi/agent/settings.json (HOME-redirected here)
 *  - per-key validation: "" palace unset, save_interval positive int,
 *    recall_on_prompt boolean, children.recall/curation booleans
 *  - missing/malformed files and wrong-typed values → per-key defaults,
 *    never a throw
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readMempalaceSettings } from "../infrastructure/settings-reader";
import { DEFAULT_MEMPALACE_SETTINGS, SAVE_INTERVAL } from "../domain/types";

let scratch = "";
let savedHome = "";
let savedAgentDir: string | undefined;

/** Write a JSON file, creating parent dirs. */
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

/** Write the profile leg under the redirected HOME (~/.pi/<rel>/settings.json). */
function writeProfileSettings(
	mempalace: unknown,
	rel = "agent",
): Promise<void> {
	return writeJson(join(scratch, "home", ".pi", rel, "settings.json"), {
		mempalace,
	});
}

beforeEach(async () => {
	scratch = await mkdtemp(join(tmpdir(), "settings-reader-"));
	await mkdir(join(scratch, "project", ".pi"), { recursive: true });
	// os.homedir() reads $HOME per call on POSIX, so redirecting HOME makes
	// the ~/.pi fallback path hermetic.
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

describe("readMempalaceSettings — precedence", () => {
	it("returns defaults when no settings files exist anywhere", async () => {
		assert.deepEqual(await readMempalaceSettings(projectCwd()), {
			palace: undefined,
			saveInterval: SAVE_INTERVAL,
			recallOnPrompt: true,
			children: { recall: false, curation: false },
		});
	});

	it("project wins per key; profile fills the keys the project omits", async () => {
		await writeProfileSettings({ recall_on_prompt: false, save_interval: 7 });
		await writeProjectSettings({
			recall_on_prompt: true,
			children: { curation: true },
		});

		const s = await readMempalaceSettings(projectCwd());

		assert.equal(s.recallOnPrompt, true, "project value wins");
		assert.equal(
			s.saveInterval,
			7,
			"profile value applies where project is silent",
		);
		assert.deepEqual(
			s.children,
			{ recall: false, curation: true },
			"per-key inside children too",
		);
	});

	it("project file with no mempalace block leaves the profile leg intact", async () => {
		await writeProfileSettings({ palace: "/from/profile" });
		await writeJson(join(scratch, "project", ".pi", "settings.json"), {
			theme: "dark",
		});

		const s = await readMempalaceSettings(projectCwd());

		assert.equal(s.palace, "/from/profile");
	});

	it("omitting cwd reads the profile leg only", async () => {
		await writeProfileSettings({ save_interval: 3 });

		const s = await readMempalaceSettings();

		assert.equal(s.saveInterval, 3);
	});
});

describe("readMempalaceSettings — profile path resolution", () => {
	it("PI_CODING_AGENT_DIR (absolute) selects that dir's settings.json", async () => {
		const absDir = join(scratch, "abs-profile");
		process.env.PI_CODING_AGENT_DIR = absDir;
		await writeJson(join(absDir, "settings.json"), {
			mempalace: { recall_on_prompt: false },
		});

		const s = await readMempalaceSettings(projectCwd());

		assert.equal(s.recallOnPrompt, false);
	});

	it("PI_CODING_AGENT_DIR (relative) resolves against ~/.pi", async () => {
		process.env.PI_CODING_AGENT_DIR = "personal";
		await writeProfileSettings({ children: { recall: true } }, "personal");

		const s = await readMempalaceSettings(projectCwd());

		assert.deepEqual(s.children, { recall: true, curation: false });
	});

	it("PI_CODING_AGENT_DIR unset falls back to ~/.pi/agent/settings.json", async () => {
		await writeProfileSettings({ save_interval: 5 });

		const s = await readMempalaceSettings(projectCwd());

		assert.equal(s.saveInterval, 5);
	});

	it("empty PI_CODING_AGENT_DIR behaves like unset", async () => {
		process.env.PI_CODING_AGENT_DIR = "";
		await writeProfileSettings({ save_interval: 6 });

		const s = await readMempalaceSettings(projectCwd());

		assert.equal(s.saveInterval, 6);
	});

	it("project still wins over the profile found via PI_CODING_AGENT_DIR", async () => {
		process.env.PI_CODING_AGENT_DIR = join(scratch, "abs-profile");
		await writeJson(join(scratch, "abs-profile", "settings.json"), {
			mempalace: { save_interval: 99 },
		});
		await writeProjectSettings({ save_interval: 2 });

		const s = await readMempalaceSettings(projectCwd());

		assert.equal(s.saveInterval, 2);
	});
});

describe("readMempalaceSettings — per-key validation", () => {
	it('palace "" counts as unset (and never contributes a value)', async () => {
		await writeProjectSettings({ palace: "" });

		const s = await readMempalaceSettings(projectCwd());

		assert.equal(s.palace, undefined);
	});

	it("palace passes through verbatim when set", async () => {
		await writeProjectSettings({ palace: "~/palaces/override" });

		const s = await readMempalaceSettings(projectCwd());

		assert.equal(s.palace, "~/palaces/override");
	});

	it("save_interval accepts any positive integer", async () => {
		for (const [raw, expected] of [
			[1, 1],
			[42, 42],
		] as const) {
			await writeProjectSettings({ save_interval: raw });
			const s = await readMempalaceSettings(projectCwd());
			assert.equal(s.saveInterval, expected, `save_interval=${raw}`);
		}
	});

	it("save_interval rejects non-positive-integers → default", async () => {
		for (const raw of [0, -3, 2.5, "15", null, true]) {
			await writeProjectSettings({ save_interval: raw });
			const s = await readMempalaceSettings(projectCwd());
			assert.equal(
				s.saveInterval,
				SAVE_INTERVAL,
				`save_interval=${JSON.stringify(raw)} must fall back`,
			);
		}
	});

	it("recall_on_prompt must be boolean → default true otherwise", async () => {
		for (const raw of ["false", 0, null]) {
			await writeProjectSettings({ recall_on_prompt: raw });
			const s = await readMempalaceSettings(projectCwd());
			assert.equal(
				s.recallOnPrompt,
				true,
				`recall_on_prompt=${JSON.stringify(raw)}`,
			);
		}
		await writeProjectSettings({ recall_on_prompt: false });
		assert.equal(
			(await readMempalaceSettings(projectCwd())).recallOnPrompt,
			false,
		);
	});

	it("children keys must be booleans; each falls back independently", async () => {
		await writeProjectSettings({
			children: { recall: "yes", curation: 0 },
		});

		const s = await readMempalaceSettings(projectCwd());

		assert.deepEqual(s.children, { recall: false, curation: false });
	});

	it("malformed children block → children defaults, other keys still parse", async () => {
		await writeProjectSettings({
			save_interval: 4,
			children: "nope",
		});

		const s = await readMempalaceSettings(projectCwd());

		assert.equal(s.saveInterval, 4);
		assert.deepEqual(s.children, { recall: false, curation: false });
	});

	it("malformed mempalace block → whole block defaults", async () => {
		await writeProjectSettings("just a string");

		const s = await readMempalaceSettings(projectCwd());

		assert.deepEqual(s, {
			palace: undefined,
			saveInterval: SAVE_INTERVAL,
			recallOnPrompt: true,
			children: { recall: false, curation: false },
		});
	});
});

describe("readMempalaceSettings — malformed files never throw", () => {
	it("unparseable project file contributes nothing; profile still applies", async () => {
		await writeProfileSettings({ save_interval: 8 });
		await mkdir(dirname(join(scratch, "project", ".pi", "settings.json")), {
			recursive: true,
		});
		await writeFile(
			join(scratch, "project", ".pi", "settings.json"),
			"{ not json !!!",
		);

		const s = await readMempalaceSettings(projectCwd());

		assert.equal(s.saveInterval, 8, "malformed project file is skipped");
		assert.equal(s.recallOnPrompt, true);
	});

	it("unparseable profile file contributes nothing; project still applies", async () => {
		await mkdir(dirname(join(scratch, "home", ".pi", "agent", "settings.json")), {
			recursive: true,
		});
		await writeFile(
			join(scratch, "home", ".pi", "agent", "settings.json"),
			"[1, 2",
		);
		await writeProjectSettings({ children: { recall: true } });

		const s = await readMempalaceSettings(projectCwd());

		assert.deepEqual(s.children, { recall: true, curation: false });
	});

	it("top-level JSON that is not an object (array/null) counts as malformed", async () => {
		await writeJson(join(scratch, "project", ".pi", "settings.json"), ["nope"]);
		assert.deepEqual(
			await readMempalaceSettings(projectCwd()),
			DEFAULT_MEMPALACE_SETTINGS,
		);

		await writeJson(join(scratch, "project", ".pi", "settings.json"), null);
		assert.deepEqual(
			await readMempalaceSettings(projectCwd()),
			DEFAULT_MEMPALACE_SETTINGS,
		);
	});
});
