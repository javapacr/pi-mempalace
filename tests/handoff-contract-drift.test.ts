/**
 * Contract drift test (W3, D20, epic R2): pins pi-mempalace's mirror of the
 * pi-handoff shared-bus contract (domain/handoff-contract.ts) against
 * pi-handoff's own source — the repos share no types and pi-mempalace takes
 * no dependency on pi-handoff.
 *
 * Both sides go through the same formatting-tolerant reader
 * (tests/helpers/ts-contract.ts): comments and whitespace do not matter,
 * unions compare as sets, interface members as name → {optional, type}
 * maps regardless of order or `readonly` (W3.R2).
 *
 * Source: the pi-handoff git repo at
 *  - `PI_HANDOFF_DIR` when set — only it, no fallback, so a bogus value
 *    skips deterministically;
 *  - otherwise the `pi-handoff` sibling of the MAIN checkout, found through
 *    the git common dir (a worktree's own `../pi-handoff` points inside
 *    `.worktrees/`);
 * read at the committed ref `PI_HANDOFF_REF` (default `HEAD`) through
 * `git show` — never the working tree, so uncommitted edits there cannot
 * move the verdict. Every test skips with the reason when
 * `infrastructure/event-channels.ts` is not in that ref.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { HANDOFF_WAIT_SELF_BOUND_MS } from "../domain/handoff-contract";
import {
	interfaceMembers,
	numericConst,
	readCommitted,
	stringObject,
	unionMembers,
} from "./helpers/ts-contract";

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
const ref = process.env.PI_HANDOFF_REF || "HEAD";

function theirs(rel: string): string {
	const src = handoffDir ? readCommitted(handoffDir, ref, rel) : null;
	assert.ok(src !== null, `pi-handoff ${ref}:${rel} is readable`);
	return src;
}

const SKIP: string | undefined =
	handoffDir &&
	readCommitted(handoffDir, ref, "infrastructure/event-channels.ts") !== null
		? undefined
		: `pi-handoff repo not found at ${handoffDir ?? "(unresolved)"} ref ${ref} (set PI_HANDOFF_DIR / PI_HANDOFF_REF)`;

/** pi-mempalace's own mirror, read through the same parser as pi-handoff. */
const ours = readFileSync(join(__dirname, "..", "domain", "handoff-contract.ts"), "utf8");

function members(src: string, name: string, side: string) {
	const m = interfaceMembers(src, name);
	assert.ok(m, `${side} declares interface ${name}`);
	return Object.fromEntries(m);
}

describe("pi-handoff contract (drift test)", () => {
	it("contract: the channel map matches pi-handoff's HANDOFF_CHANNELS", { skip: SKIP }, () => {
		const theirMap = stringObject(theirs("infrastructure/event-channels.ts"), "HANDOFF_CHANNELS");
		const ourMap = stringObject(ours, "HANDOFF_CHANNELS");
		assert.ok(theirMap && theirMap.size > 0, "pi-handoff declares HANDOFF_CHANNELS");
		assert.ok(ourMap && ourMap.size > 0, "pi-mempalace declares HANDOFF_CHANNELS");
		assert.deepEqual(Object.fromEntries(ourMap), Object.fromEntries(theirMap));
	});

	it("contract: trigger values, command payload fields and waitUntil match", { skip: SKIP }, () => {
		const src = theirs("domain/types.ts");
		assert.deepEqual(
			unionMembers(ours, "HandoffTrigger"),
			unionMembers(src, "HandoffTrigger"),
			"HandoffTrigger members (as a set)",
		);
		assert.deepEqual(
			unionMembers(src, "HandoffTrigger"),
			new Set(["handoff", "continue"]),
			"pi-mempalace acts on exactly these two triggers",
		);
		assert.deepEqual(
			members(ours, "HandoffCommandPayloadBase", "pi-mempalace"),
			members(src, "HandoffCommandPayloadBase", "pi-handoff"),
			"HandoffCommandPayloadBase members",
		);
		assert.deepEqual(
			members(ours, "HandoffCommandStartPayload", "pi-mempalace"),
			members(src, "HandoffCommandStartPayload", "pi-handoff"),
			"HandoffCommandStartPayload members (waitUntil)",
		);
	});

	it("contract: the handoff_tool_start payload fields match", { skip: SKIP }, () => {
		assert.deepEqual(
			members(ours, "HandoffToolStartPayload", "pi-mempalace"),
			members(theirs("domain/types.ts"), "HandoffToolEventPayload", "pi-handoff"),
			"pi-mempalace HandoffToolStartPayload mirrors pi-handoff HandoffToolEventPayload",
		);
	});

	it("contract: pi-handoff's hook-wait cap stays within pi-mempalace's self-bound", { skip: SKIP }, () => {
		const cap = numericConst(theirs("application/handoff-executor.ts"), "HOOK_WAIT_CAP_MS");
		assert.ok(cap !== null, "handoff-executor.ts declares HOOK_WAIT_CAP_MS");
		assert.equal(cap, 120_000, "pi-handoff caps the hook wait at 120s");
		assert.ok(
			cap <= HANDOFF_WAIT_SELF_BOUND_MS,
			`pi-handoff cap ${cap}ms ≤ pi-mempalace self-bound ${HANDOFF_WAIT_SELF_BOUND_MS}ms`,
		);
	});
});
