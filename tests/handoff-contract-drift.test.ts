/**
 * Contract drift test (W3, D20, epic R2): pins pi-mempalace's mirror of the
 * pi-handoff shared-bus contract (domain/handoff-contract.ts) against
 * pi-handoff's own source, read as text — the repos share no types and
 * pi-mempalace takes no dependency on pi-handoff.
 *
 * Source directory:
 *  - `PI_HANDOFF_DIR` when set — only it, no fallback, so a bogus value
 *    skips deterministically;
 *  - otherwise the `pi-handoff` sibling of the MAIN checkout, found through
 *    the git common dir (a worktree's own `../pi-handoff` points inside
 *    `.worktrees/`).
 * Every test skips with the reason when the directory has no
 * `infrastructure/event-channels.ts`.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import {
	HANDOFF_CHANNELS,
	HANDOFF_WAIT_SELF_BOUND_MS,
} from "../domain/handoff-contract";

// ESM package ("type": "module"): no CommonJS __dirname.
const __dirname = dirname(fileURLToPath(import.meta.url));

function siblingOfMainCheckout(): string | null {
	try {
		const common = execFileSync("git", ["rev-parse", "--git-common-dir"], {
			cwd: __dirname,
			encoding: "utf8",
		}).trim();
		const abs = isAbsolute(common) ? common : resolve(__dirname, common);
		// <main checkout>/.git → <main checkout>/../pi-handoff
		return join(dirname(abs), "..", "pi-handoff");
	} catch {
		return null;
	}
}

const envDir = process.env.PI_HANDOFF_DIR;
const handoffDir = envDir !== undefined ? envDir : siblingOfMainCheckout();
const channelsFile = handoffDir
	? join(handoffDir, "infrastructure", "event-channels.ts")
	: null;
const SKIP: string | undefined =
	channelsFile && existsSync(channelsFile)
		? undefined
		: `pi-handoff checkout not found at ${handoffDir ?? "(unresolved)"} (set PI_HANDOFF_DIR)`;

function read(rel: string): string {
	return readFileSync(join(handoffDir as string, rel), "utf8");
}

/** The body of `export interface <name> … { … }` (first closing brace at
 * column 0), or "" when the interface is absent. */
function interfaceBody(src: string, name: string): string {
	const m = new RegExp(
		`export interface ${name}\\b[^{]*\\{([\\s\\S]*?)\\n\\}`,
	).exec(src);
	return m ? m[1] : "";
}

describe("pi-handoff contract (drift test)", () => {
	it("contract: every channel name pi-mempalace listens on is a pi-handoff channel literal", { skip: SKIP }, () => {
		const src = read("infrastructure/event-channels.ts");
		for (const channel of Object.values(HANDOFF_CHANNELS)) {
			assert.ok(
				src.includes(`"${channel}"`),
				`pi-handoff event-channels.ts declares "${channel}"`,
			);
		}
	});

	it("contract: trigger values, command payload fields and waitUntil match", { skip: SKIP }, () => {
		const src = read("domain/types.ts");
		assert.match(
			src,
			/export type HandoffTrigger = "handoff" \| "continue";/,
			"HandoffTrigger is exactly \"handoff\" | \"continue\"",
		);
		const base = interfaceBody(src, "HandoffCommandPayloadBase");
		assert.ok(base, "HandoffCommandPayloadBase exists");
		for (const field of [
			/\bgoal: string \| null;/,
			/\bquickMode: boolean;/,
			/\btrigger: HandoffTrigger;/,
			/\btimestamp: number;/,
		]) {
			assert.match(base, field, `HandoffCommandPayloadBase has ${field}`);
		}
		const start = interfaceBody(src, "HandoffCommandStartPayload");
		assert.match(
			start,
			/\bwaitUntil\?: \(promise: Promise<unknown>\) => void;/,
			"HandoffCommandStartPayload.waitUntil keeps its shape",
		);
	});

	it("contract: the handoff_tool_start payload fields match", { skip: SKIP }, () => {
		const tool = interfaceBody(read("domain/types.ts"), "HandoffToolEventPayload");
		assert.ok(tool, "HandoffToolEventPayload exists");
		for (const field of [
			/\bgoal: string;/,
			/\bcommand: string;/,
			/\btimestamp: number;/,
		]) {
			assert.match(tool, field, `HandoffToolEventPayload has ${field}`);
		}
	});

	it("contract: pi-handoff's hook-wait cap stays within pi-mempalace's self-bound", { skip: SKIP }, () => {
		const m = /const HOOK_WAIT_CAP_MS = ([\d_]+);/.exec(
			read("application/handoff-executor.ts"),
		);
		assert.ok(m, "handoff-executor.ts declares HOOK_WAIT_CAP_MS");
		const cap = Number(m[1].replace(/_/g, ""));
		assert.equal(cap, 120_000, "pi-handoff caps the hook wait at 120s");
		assert.ok(
			cap <= HANDOFF_WAIT_SELF_BOUND_MS,
			`pi-handoff cap ${cap}ms ≤ pi-mempalace self-bound ${HANDOFF_WAIT_SELF_BOUND_MS}ms`,
		);
	});
});
