/**
 * Mining guard — transcripts MemPalace would ingest as raw JSON are skipped.
 *
 * MemPalace core parses a pi session only with a session header and >= 2
 * user/assistant text messages; below that it chunks the RAW JSONL, system
 * prompt and tool JSON schemas included (domain/pi-transcript.ts). Pins the
 * mirror of that rule and that MiningUseCase never hands such a file to
 * `mempalace mine`. The rule was cross-checked against core's `_try_pi_jsonl`
 * on 1,308 real sessions (0 mismatches, 2026-11-07).
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { isMinableTranscript } from "../infrastructure/transcript-probe";
import { classifyTranscriptLine } from "../domain/pi-transcript";
import { MiningUseCase } from "../application/mining.usecase";
import type { MempalaceCli } from "../infrastructure/mempalace-cli";
import type { MempalaceConfig } from "../domain/types";

let scratch = "";
beforeEach(async () => {
	scratch = await mkdtemp(join(tmpdir(), "transcript-probe-"));
});
afterEach(async () => {
	await rm(scratch, { recursive: true, force: true });
});

const header = { type: "session", version: 3, id: "x", cwd: "/w" };
const system = {
	type: "message",
	message: {
		role: "system",
		content: "",
		sections: { preamble: "You are…" },
		toolsAdded: [{ name: "find", parameters: { type: "object", properties: { globs: { type: "array" } } } }],
	},
};
const user = (text: string) => ({
	type: "message",
	message: { role: "user", content: [{ type: "text", text }] },
});
const assistantText = (text: string) => ({
	type: "message",
	message: { role: "assistant", content: [{ type: "thinking", thinking: "…" }, { type: "text", text }] },
});
const assistantToolOnly = {
	type: "message",
	message: { role: "assistant", content: [{ type: "toolCall", id: "t", name: "read", arguments: {} }] },
};
const toolResult = {
	type: "message",
	message: { role: "toolResult", content: [{ type: "text", text: "file body" }] },
};

async function writeJsonl(name: string, lines: unknown[]): Promise<string> {
	const file = join(scratch, name);
	await writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
	return file;
}

describe("classifyTranscriptLine (mirrors core's _try_pi_jsonl)", () => {
	it("header, conversational text, and everything else", () => {
		assert.equal(classifyTranscriptLine(header), "header");
		assert.equal(classifyTranscriptLine(user("hi")), "conversational");
		assert.equal(
			classifyTranscriptLine({ type: "message", message: { role: "user", content: "plain" } }),
			"conversational",
		);
		assert.equal(classifyTranscriptLine(assistantText("done")), "conversational");
		assert.equal(classifyTranscriptLine(assistantToolOnly), "other", "toolCall carries no text");
		assert.equal(classifyTranscriptLine(user("   ")), "other", "blank text");
		assert.equal(classifyTranscriptLine(system), "other");
		assert.equal(classifyTranscriptLine(toolResult), "other");
		assert.equal(
			classifyTranscriptLine({ type: "custom_message", customType: "mempalace-recall", content: "r" }),
			"other",
		);
		assert.equal(classifyTranscriptLine({ type: "session" }), "other", "header needs a version");
	});
});

describe("isMinableTranscript", () => {
	it("one prompt + tool-only replies (the raw-fallback shape) → not minable", async () => {
		const f = await writeJsonl("short.jsonl", [
			header, system, user("list your tools"), assistantToolOnly, toolResult, assistantToolOnly,
		]);
		assert.equal(isMinableTranscript(f), false);
	});

	it("user + assistant text → minable", async () => {
		const f = await writeJsonl("ok.jsonl", [header, system, user("q"), assistantText("a")]);
		assert.equal(isMinableTranscript(f), true);
	});

	it("no session header → not minable (core would not claim it as pi either)", async () => {
		const f = await writeJsonl("nohdr.jsonl", [user("q"), assistantText("a")]);
		assert.equal(isMinableTranscript(f), false);
	});

	it("verdict found past the first 64 KiB chunk; malformed and split lines tolerated", async () => {
		const big = "x".repeat(200 * 1024);
		const file = join(scratch, "big.jsonl");
		await writeFile(
			file,
			[
				JSON.stringify(header),
				"{not json",
				JSON.stringify(toolResult).replace("file body", big),
				JSON.stringify(user("q")),
				JSON.stringify(assistantText("a")),
			].join("\n"),
		);
		assert.equal(isMinableTranscript(file), true);
	});

	it("a multibyte character split across the 64 KiB chunk boundary still parses", async () => {
		// Pad the first line so the 3-byte "€" in the user text straddles byte 65536.
		const head = JSON.stringify(header) + "\n";
		const userPrefix = '{"type":"message","message":{"role":"user","content":"';
		const pad = 65536 - Buffer.byteLength(head) - Buffer.byteLength(userPrefix) - 1;
		const userLine = `${userPrefix}${"a".repeat(pad)}€"}}`;
		const file = join(scratch, "utf8.jsonl");
		await writeFile(file, head + userLine + "\n" + JSON.stringify(assistantText("a")) + "\n");
		assert.equal(isMinableTranscript(file), true);
	});

	it("missing file → true (mine anyway; the guard only skips the known raw fallback)", () => {
		assert.equal(isMinableTranscript(join(scratch, "nope.jsonl")), true);
	});
});

describe("MiningUseCase skips unminable transcripts", () => {
	function recordingCli() {
		const calls: string[][] = [];
		const cli = {
			run: async (args: string[]) => {
				calls.push(args);
				return "ok";
			},
			spawnBackground: (args: string[]) => {
				calls.push(args);
			},
		} as unknown as MempalaceCli;
		return { cli, calls };
	}
	const config: MempalaceConfig = { palace: "/p", wing: null, rooms: [] };

	it("mineSync and mineBackground make no CLI call for an unminable file", async () => {
		const { cli, calls } = recordingCli();
		const f = await writeJsonl("short.jsonl", [header, system, user("q"), assistantToolOnly]);
		const mining = new MiningUseCase(cli);
		await mining.mineSync(f, scratch);
		mining.mineBackground(f, config);
		assert.deepEqual(calls, []);
	});

	it("a minable file still mines on both paths", async () => {
		const { cli, calls } = recordingCli();
		const f = await writeJsonl("ok.jsonl", [header, user("q"), assistantText("a")]);
		const mining = new MiningUseCase(cli);
		await mining.mineSync(f, scratch);
		mining.mineBackground(f, config);
		assert.equal(calls.length, 2);
		assert.equal(calls[0][1], f);
		assert.equal(calls[1][1], f);
	});
});
