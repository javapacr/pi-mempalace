/**
 * Unit tests for MiningUseCase — pins the exact mempalace CLI argv.
 *
 * The lifecycle mine must stay file-granular:
 *   `mine <sessionFile> --mode convos --wing sessions`
 * Dropping `--mode convos` (or passing a directory) keeps every handler
 * test green while silently breaking runtime mining, so the argv contract
 * is pinned here directly against the use case.
 */

import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { MiningUseCase } from "../application/mining.usecase";
import type { MempalaceCli } from "../infrastructure/mempalace-cli";
import type { MempalaceConfig } from "../domain/types";

let scratch = "";
let savedEnv: Record<string, string | undefined> = {};

const ENV_KEYS = ["MEMPALACE_PALACE", "PI_CODING_AGENT_DIR"] as const;

interface RecordedCall {
	args: string[];
	config?: MempalaceConfig;
}

function recordingCli() {
	const calls: RecordedCall[] = [];
	const cli = {
		run: async (args: string[], config?: MempalaceConfig) => {
			calls.push({ args, config });
			return "ok";
		},
		spawnBackground: (args: string[], config: MempalaceConfig) => {
			calls.push({ args, config });
		},
	} as unknown as MempalaceCli;
	return { cli, calls };
}

beforeEach(async () => {
	scratch = await mkdtemp(join(tmpdir(), "mining-usecase-"));
	await mkdir(join(scratch, "agent"), { recursive: true });
	savedEnv = {};
	for (const k of ENV_KEYS) {
		savedEnv[k] = process.env[k];
		delete process.env[k];
	}
	// Hermetic redirections: palace + agent dir into the scratch tmpdir.
	process.env.MEMPALACE_PALACE = join(scratch, "palace");
	process.env.PI_CODING_AGENT_DIR = join(scratch, "agent");
});

afterEach(async () => {
	for (const k of ENV_KEYS) {
		if (savedEnv[k] === undefined) delete process.env[k];
		else process.env[k] = savedEnv[k];
	}
	await rm(scratch, { recursive: true, force: true });
});

describe("MiningUseCase argv contract", () => {
	const sessionFile = () => join(scratch, "sessions", "outgoing.jsonl");

	it("mineSync runs mine on the session file with convos mode + sessions wing", async () => {
		const { cli, calls } = recordingCli();
		const mining = new MiningUseCase(cli);

		await mining.mineSync(sessionFile(), scratch);

		assert.equal(calls.length, 1);
		assert.deepEqual(calls[0].args, [
			"mine",
			sessionFile(),
			"--mode",
			"convos",
			"--wing",
			"sessions",
		]);
		assert.equal(
			calls[0].config?.palace,
			join(scratch, "palace"),
			"config must resolve from the hermetic MEMPALACE_PALACE",
		);
	});

	it("mineBackground spawns the same argv on the session file", () => {
		const { cli, calls } = recordingCli();
		const mining = new MiningUseCase(cli);
		const config: MempalaceConfig = {
			palace: "/tmp/palace",
			wing: null,
			rooms: [],
		};

		mining.mineBackground(sessionFile(), config);

		assert.equal(calls.length, 1);
		assert.deepEqual(calls[0].args, [
			"mine",
			sessionFile(),
			"--mode",
			"convos",
			"--wing",
			"sessions",
		]);
		assert.equal(calls[0].config, config);
	});

	it("mineSync swallows CLI errors (non-fatal before compaction)", async () => {
		const cli = {
			run: async () => {
				throw new Error("boom");
			},
			spawnBackground: () => {},
		} as unknown as MempalaceCli;
		const mining = new MiningUseCase(cli);

		await assert.doesNotReject(mining.mineSync(sessionFile(), scratch));
	});
});
