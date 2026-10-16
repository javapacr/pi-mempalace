/**
 * The drift test's reader (tests/helpers/ts-contract.ts, W3.R2): a
 * reformatted pi-handoff source still matches, a real contract change still
 * fails, and only committed content counts.
 */

import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	interfaceExtends,
	interfaceMembers,
	numericConst,
	readCommitted,
	stringObject,
	unionMembers,
} from "./helpers/ts-contract";

const CANONICAL = `
export type HandoffTrigger = "handoff" | "continue";
export interface HandoffCommandPayloadBase {
	/** The goal; null when inferred. */
	goal: string | null;
	quickMode: boolean;
	trigger: HandoffTrigger;
	timestamp: number;
	meta: Map<string, number>;
	mode: "a" | "b";
}
export interface HandoffCommandStartPayload extends HandoffCommandPayloadBase {
	waitUntil?: (promise: Promise<unknown>) => void;
}
export const HANDOFF_CHANNELS = {
	toolStart: "handoff_tool_start",
	commandStart: "handoff_command_start",
} as const;
const HOOK_WAIT_CAP_MS = 120_000;
`;

// Same contract: other quotes, leading pipe, multi-line union, reordered
// members, readonly, trailing commas, comments with braces and semicolons,
// a type annotation on the constant.
const REFORMATTED = `
// a comment with { braces; } and "quotes" | pipes
export type HandoffTrigger =
	| 'continue'
	| 'handoff';
export interface HandoffCommandPayloadBase
{
	readonly timestamp: number,
	/* trigger; see { docs } */ readonly trigger : HandoffTrigger,
	readonly quickMode: boolean, // legacy; mirrors trigger
	readonly mode: 'b' | 'a',
	readonly meta: Map< string , number >,
	readonly goal: null|string,
}
export interface HandoffCommandStartPayload
	extends HandoffCommandPayloadBase {
	readonly waitUntil ?: ( promise : Promise< unknown > ) =>void
}
export const HANDOFF_CHANNELS = {
	'commandStart': 'handoff_command_start',
	toolStart: \`handoff_tool_start\`, // legacy: { tool, ; }
} as const
const HOOK_WAIT_CAP_MS: number = 120000;
`;

function shape(src: string) {
	const obj = (name: string) => {
		const m = interfaceMembers(src, name);
		return m ? Object.fromEntries(m) : null;
	};
	const channels = stringObject(src, "HANDOFF_CHANNELS");
	return {
		trigger: unionMembers(src, "HandoffTrigger"),
		base: obj("HandoffCommandPayloadBase"),
		start: obj("HandoffCommandStartPayload"),
		channels: channels ? Object.fromEntries(channels) : null,
		cap: numericConst(src, "HOOK_WAIT_CAP_MS"),
		extends: interfaceExtends(src, "HandoffCommandStartPayload"),
	};
}

describe("contract reader (W3.R2)", () => {
	it("contract reader: reformatting, reordering and comments read as the same contract", () => {
		const a = shape(CANONICAL);
		assert.deepEqual(shape(REFORMATTED), a);
		assert.deepEqual(a.trigger, new Set(["handoff", "continue"]));
		assert.equal(a.cap, 120_000);
		assert.equal(a.base?.goal.type, shape(REFORMATTED).base?.goal.type);
		assert.deepEqual(a.start?.waitUntil, {
			optional: true,
			type: "(promise:Promise<unknown>)=>void",
		});
		// Explicit types: deepEqual alone would pass if both sides mis-parsed
		// nested separators or literal quotes the same way.
		assert.deepEqual(a.base?.meta, { optional: false, type: "Map<string,number>" });
		assert.deepEqual(a.base?.mode, { optional: false, type: '"a"|"b"' });
		assert.deepEqual(a.base?.quickMode, { optional: false, type: "boolean" });
		assert.deepEqual(a.extends, new Set(["HandoffCommandPayloadBase"]));
		assert.equal(Object.keys(a.base ?? {}).length, 6, "six base members, no comment debris");
		assert.deepEqual(Object.keys(a.channels ?? {}).sort(), ["commandStart", "toolStart"]);
	});

	it("contract reader: real contract changes still read differently", () => {
		const base = shape(CANONICAL);
		const drifts: ReadonlyArray<readonly [string, string]> = [
			["trigger value", CANONICAL.replace('"continue"', '"resume"')],
			["extra trigger", CANONICAL.replace('"continue";', '"continue" | "fork";')],
			["field renamed", CANONICAL.replace("quickMode:", "quick:")],
			["field type", CANONICAL.replace("timestamp: number", "timestamp: string")],
			["optional flipped", CANONICAL.replace("waitUntil?:", "waitUntil:")],
			["waitUntil shape", CANONICAL.replace("=> void", "=> Promise<void>")],
			["channel renamed", CANONICAL.replace('"handoff_tool_start"', '"handoff_tool_begin"')],
			["cap changed", CANONICAL.replace("120_000", "180_000")],
			["re-parented", CANONICAL.replace(
				"HandoffCommandStartPayload extends HandoffCommandPayloadBase",
				"HandoffCommandStartPayload extends OtherBase",
			)],
		];
		for (const [label, src] of drifts) {
			assert.notDeepEqual(shape(src), base, `${label} is detected`);
		}
	});

	describe("committed content only", () => {
		let repo = "";
		before(async () => {
			repo = await mkdtemp(join(tmpdir(), "ts-contract-"));
			const git = (...args: string[]) =>
				execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
			git("init", "-q");
			await mkdir(join(repo, "domain"), { recursive: true });
			await writeFile(join(repo, "domain", "types.ts"), CANONICAL);
			git("add", ".");
			git(
				"-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false",
				"commit", "-q", "-m", "c",
			);
			// A second commit with a drift, so HEAD~1 and HEAD differ.
			await writeFile(join(repo, "domain", "types.ts"), CANONICAL.replace('"continue"', '"fork"'));
			git("add", ".");
			git(
				"-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false",
				"commit", "-q", "-m", "drift",
			);
			// An uncommitted drift in the working tree.
			await writeFile(
				join(repo, "domain", "types.ts"),
				CANONICAL.replace('"continue"', '"resume"'),
			);
		});
		after(async () => {
			if (repo) await rm(repo, { recursive: true, force: true });
		});

		it("contract reader: git show reads the commit, not the dirty working tree", () => {
			const head = readCommitted(repo, "HEAD", "domain/types.ts");
			assert.ok(head !== null);
			assert.deepEqual(unionMembers(head, "HandoffTrigger"), new Set(["handoff", "fork"]), "HEAD, not the dirty tree");
			const prev = readCommitted(repo, "HEAD~1", "domain/types.ts");
			assert.ok(prev !== null);
			assert.deepEqual(unionMembers(prev, "HandoffTrigger"), new Set(["handoff", "continue"]), "the ref is honoured");
			assert.equal(readCommitted(repo, "no-such-ref", "domain/types.ts"), null, "missing ref → null");
			assert.equal(readCommitted(repo, "HEAD", "missing.ts"), null, "missing path → null");
			assert.equal(readCommitted("/nonexistent", "HEAD", "domain/types.ts"), null, "missing repo → null");
		});
	});
});
