/**
 * Unit tests for the subagent-child wake-up gate (PRD §4 Feature A).
 *
 * Covers:
 *  - AC-A4: resolveChildWakeupGate truth table (exact === "1" semantics).
 *  - AC-A5: recording wakeUp stub — child env: 0 execute calls across
 *    session_start + 2 turns; parent env: exactly 1; hatch: 1.
 *  - AC-A2: under child env with a recall hit, before_agent_start returns
 *    the RECALL_CUSTOM_TYPE message and NO systemPrompt key.
 *  - A1 over-gate pin: child session_start still resolves the palace
 *    config (session_shutdown mining) while skipping wake-up.
 *  - A3 per-event hatch: flipping PI_MEMPALACE_CHILD_WAKEUP between turns
 *    changes behavior (never factory-frozen).
 *  - A6: one-time skip/hatch log lines.
 */

import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveChildWakeupGate } from "../domain/child-gate";
import { registerMempalaceEvents } from "../infrastructure/event-registration";
import {
	SessionState,
	RECALL_CUSTOM_TYPE,
	type SearchResult,
} from "../domain/types";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { WakeUpUseCase } from "../application/wake-up.usecase";
import type { RecallUseCase } from "../application/recall.usecase";
import type { CurationUseCase } from "../application/curation.usecase";
import type { MiningUseCase } from "../application/mining.usecase";

// ── resolveChildWakeupGate truth table (AC-A4) ───────────────────────────────

describe("resolveChildWakeupGate (AC-A4)", () => {
	it("treats PI_SUBAGENT_CHILD unset as parent", () => {
		const g = resolveChildWakeupGate({});
		assert.deepEqual(g, {
			isChild: false,
			skipWakeUp: false,
			hatchUsed: false,
			reason: "parent",
		});
	});

	it("requires exact PI_SUBAGENT_CHILD === \"1\" (\"0\", \"true\", \"yes\", \"2\" are parents)", () => {
		for (const v of ["0", "true", "yes", "2", ""]) {
			assert.equal(resolveChildWakeupGate({ PI_SUBAGENT_CHILD: v }).isChild, false, `PI_SUBAGENT_CHILD=${JSON.stringify(v)}`);
		}
		assert.equal(resolveChildWakeupGate({ PI_SUBAGENT_CHILD: "1" }).isChild, true);
	});

	it("gates a plain child (no hatch)", () => {
		const g = resolveChildWakeupGate({
			PI_SUBAGENT_CHILD: "1",
			PI_SUBAGENT_CHILD_AGENT: "worker",
		});
		assert.deepEqual(g, {
			isChild: true,
			skipWakeUp: true,
			hatchUsed: false,
			reason: "child-gated",
		});
	});

	it("hatch without csv applies fleet-wide", () => {
		const g = resolveChildWakeupGate({
			PI_SUBAGENT_CHILD: "1",
			PI_MEMPALACE_CHILD_WAKEUP: "1",
		});
		assert.deepEqual(g, {
			isChild: true,
			skipWakeUp: false,
			hatchUsed: true,
			reason: "child-hatch-fleet",
		});
	});

	it("empty/whitespace csv counts as no csv (fleet-wide hatch)", () => {
		for (const csv of ["", "   ", " , , "]) {
			const g = resolveChildWakeupGate({
				PI_SUBAGENT_CHILD: "1",
				PI_MEMPALACE_CHILD_WAKEUP: "1",
				PI_MEMPALACE_CHILD_WAKEUP_AGENTS: csv,
			});
			assert.equal(g.reason, "child-hatch-fleet", `csv=${JSON.stringify(csv)}`);
			assert.equal(g.skipWakeUp, false);
		}
	});

	it("scoped hatch: agent listed in csv → wake-up allowed", () => {
		const g = resolveChildWakeupGate({
			PI_SUBAGENT_CHILD: "1",
			PI_MEMPALACE_CHILD_WAKEUP: "1",
			PI_MEMPALACE_CHILD_WAKEUP_AGENTS: "scout",
			PI_SUBAGENT_CHILD_AGENT: "scout",
		});
		assert.deepEqual(g, {
			isChild: true,
			skipWakeUp: false,
			hatchUsed: true,
			reason: "child-hatch-scoped",
		});
	});

	it("scoped hatch: csv tokens are trimmed (\"scout, worker\" matches \"worker\")", () => {
		const g = resolveChildWakeupGate({
			PI_SUBAGENT_CHILD: "1",
			PI_MEMPALACE_CHILD_WAKEUP: "1",
			PI_MEMPALACE_CHILD_WAKEUP_AGENTS: "scout, worker",
			PI_SUBAGENT_CHILD_AGENT: "worker",
		});
		assert.equal(g.reason, "child-hatch-scoped");
		assert.equal(g.skipWakeUp, false);
	});

	it("scoped hatch: agent NOT in csv → stays gated (AC-A4 row)", () => {
		const g = resolveChildWakeupGate({
			PI_SUBAGENT_CHILD: "1",
			PI_MEMPALACE_CHILD_WAKEUP: "1",
			PI_MEMPALACE_CHILD_WAKEUP_AGENTS: "scout",
			PI_SUBAGENT_CHILD_AGENT: "worker",
		});
		assert.deepEqual(g, {
			isChild: true,
			skipWakeUp: true,
			hatchUsed: false,
			reason: "child-hatch-out-of-scope",
		});
	});

	it("scoped hatch: matching is case-sensitive (\"Scout\" ≠ \"scout\")", () => {
		const g = resolveChildWakeupGate({
			PI_SUBAGENT_CHILD: "1",
			PI_MEMPALACE_CHILD_WAKEUP: "1",
			PI_MEMPALACE_CHILD_WAKEUP_AGENTS: "scout",
			PI_SUBAGENT_CHILD_AGENT: "Scout",
		});
		assert.equal(g.reason, "child-hatch-out-of-scope");
		assert.equal(g.skipWakeUp, true);
	});

	it("scoped hatch: agent unset → stays gated", () => {
		const g = resolveChildWakeupGate({
			PI_SUBAGENT_CHILD: "1",
			PI_MEMPALACE_CHILD_WAKEUP: "1",
			PI_MEMPALACE_CHILD_WAKEUP_AGENTS: "scout",
		});
		assert.equal(g.reason, "child-hatch-out-of-scope");
	});

	it("hatch requires exact PI_MEMPALACE_CHILD_WAKEUP === \"1\"", () => {
		for (const v of ["0", "true", "yes", ""]) {
			const g = resolveChildWakeupGate({
				PI_SUBAGENT_CHILD: "1",
				PI_MEMPALACE_CHILD_WAKEUP: v,
			});
			assert.equal(g.reason, "child-gated", `WAKEUP=${JSON.stringify(v)}`);
			assert.equal(g.skipWakeUp, true);
		}
	});

	it("csv without the hatch does nothing (child stays gated)", () => {
		const g = resolveChildWakeupGate({
			PI_SUBAGENT_CHILD: "1",
			PI_MEMPALACE_CHILD_WAKEUP_AGENTS: "worker",
			PI_SUBAGENT_CHILD_AGENT: "worker",
		});
		assert.equal(g.reason, "child-gated");
		assert.equal(g.skipWakeUp, true);
	});
});

// ── Handler-level behavior (AC-A2/A5 + A1/A3/A6 pins) ───────────────────────

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

interface Harness {
	state: SessionState;
	handlers: Map<string, Handler[]>;
	wakeUpCalls: string[];
	installerCalls: string[];
	mineBackgroundCalls: string[];
	recallHits: SearchResult;
	setEnv(env: Record<string, string | undefined>): void;
	driveSessionStart(mode?: string): Promise<void>;
	driveTurn(prompt?: string): Promise<Record<string, unknown> | undefined>;
	driveShutdown(reason: string, sessionFile: string | null): void;
}

const GATE_ENV_KEYS = [
	"PI_SUBAGENT_CHILD",
	"PI_SUBAGENT_CHILD_AGENT",
	"PI_MEMPALACE_CHILD_WAKEUP",
	"PI_MEMPALACE_CHILD_WAKEUP_AGENTS",
	"MEMPALACE_PALACE",
	"PI_CODING_AGENT_DIR",
] as const;

let savedEnv: Record<string, string | undefined> = {};
let scratch = "";

function buildHarness(recallHits: SearchResult): Harness {
	const state = new SessionState();
	const handlers = new Map<string, Handler[]>();
	const wakeUpCalls: string[] = [];
	const installerCalls: string[] = [];
	const mineBackgroundCalls: string[] = [];

	const pi = {
		on: (name: string, fn: Handler) => {
			const list = handlers.get(name) ?? [];
			list.push(fn);
			handlers.set(name, list);
		},
		registerCommand: () => {},
		sendMessage: () => {},
	} as unknown as ExtensionAPI;

	const wakeUp = {
		execute: async (cwd: string) => {
			wakeUpCalls.push(cwd);
			return "WAKE-UP-CONTENT";
		},
	} as unknown as WakeUpUseCase;

	const recall = {
		execute: async () => recallHits,
	} as unknown as RecallUseCase;

	const curation = { buildPrompt: async () => ({ prompt: "x" }) } as unknown as CurationUseCase;
	const mining = {
		mineSync: async () => {},
		mineBackground: (dir: string) => {
			mineBackgroundCalls.push(dir);
		},
	} as unknown as MiningUseCase;

	// Recording installer stub: any touch is recorded and throws, so an
	// accidental skill-sync call is both visible and harmless (syncSkills
	// swallows via .catch; MANAGED_SKILLS is empty so it should never fire).
	const skillInstaller = new Proxy(
		{},
		{
			get: (_t, prop) => {
				installerCalls.push(String(prop));
				throw new Error(`unexpected skill-installer call: ${String(prop)}`);
			},
		},
	) as never;

	registerMempalaceEvents(pi, state, wakeUp, recall, curation, mining, skillInstaller);

	const ctxBase = () => ({
		mode: "interactive",
		cwd: scratch,
		sessionManager: { getSessionFile: () => null },
	});

	return {
		state,
		handlers,
		wakeUpCalls,
		installerCalls,
		mineBackgroundCalls,
		recallHits,
		setEnv: (env) => {
			for (const [k, v] of Object.entries(env)) {
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
		},
		driveSessionStart: async (mode = "interactive") => {
			const fns = handlers.get("session_start") ?? [];
			assert.ok(fns.length > 0, "session_start handler registered");
			for (const fn of fns) await fn({}, { ...ctxBase(), mode });
		},
		driveTurn: async (prompt = "please remember the palindrome drawer for this task") => {
			const fns = handlers.get("before_agent_start") ?? [];
			assert.ok(fns.length > 0, "before_agent_start handler registered");
			let last: Record<string, unknown> | undefined;
			for (const fn of fns) {
				const r = await fn(
					{ prompt, systemPrompt: "BASE SYSTEM PROMPT" },
					ctxBase(),
				);
				if (r && typeof r === "object") last = r as Record<string, unknown>;
			}
			return last;
		},
		driveShutdown: (reason: string, sessionFile: string | null) => {
			const fns = handlers.get("session_shutdown") ?? [];
			assert.ok(fns.length > 0, "session_shutdown handler registered");
			for (const fn of fns) {
				fn(
					{ type: "session_shutdown", reason },
					{ ...ctxBase(), sessionManager: { getSessionFile: () => sessionFile } },
				);
			}
		},
	};
}

beforeEach(async () => {
	scratch = await mkdtemp(join(tmpdir(), "child-gate-"));
	await mkdir(join(scratch, "agent"), { recursive: true });
	savedEnv = {};
	for (const k of GATE_ENV_KEYS) {
		savedEnv[k] = process.env[k];
		delete process.env[k];
	}
	// Hermetic redirections: palace + agent dir into the scratch tmpdir.
	process.env.MEMPALACE_PALACE = join(scratch, "palace");
	process.env.PI_CODING_AGENT_DIR = join(scratch, "agent");
});

afterEach(async () => {
	for (const k of GATE_ENV_KEYS) {
		if (savedEnv[k] === undefined) delete process.env[k];
		else process.env[k] = savedEnv[k];
	}
	await rm(scratch, { recursive: true, force: true });
});

describe("session gating (AC-A5, A1 pins)", () => {
	it("child env: wakeUp.execute called 0 times across session_start + 2 turns; config still resolved; installer untouched", async () => {
		const h = buildHarness({ snippets: [], wing: null, palace: "/tmp/palace" });
		h.setEnv({ PI_SUBAGENT_CHILD: "1", PI_SUBAGENT_CHILD_AGENT: "worker" });

		await h.driveSessionStart();
		await h.driveTurn();
		await h.driveTurn();

		assert.equal(h.wakeUpCalls.length, 0, "wakeUp.execute must never run in a child");
		assert.equal(h.installerCalls.length, 0, "skill installer must never be touched in a child");
		assert.equal(h.state.wakeUpContext, null, "no wake-up context in a child");
		assert.ok(h.state.config, "palace config must still resolve in a child (session_shutdown mining)");
		assert.equal(h.state.config?.palace, join(scratch, "palace"), "config resolved from the env palace leg");
	});

	it("parent env: wakeUp.execute called exactly 1 time across session_start + 2 turns; systemPrompt keeps the wake-up block", async () => {
		const h = buildHarness({ snippets: [], wing: null, palace: "/tmp/palace" });
		h.setEnv({ PI_SUBAGENT_CHILD: undefined });

		await h.driveSessionStart();
		const r1 = await h.driveTurn();
		await h.driveTurn();

		assert.equal(h.wakeUpCalls.length, 1, "parent fetches wake-up exactly once (session_start); self-heal must not re-fire");
		assert.equal(h.state.wakeUpContext, "WAKE-UP-CONTENT");
		assert.ok(
			typeof r1?.systemPrompt === "string" && r1.systemPrompt.includes("[MemPalace Session Context]"),
			"parent system prompt still carries the wake-up block (A5 byte-invariance)",
		);
	});

	it("parent print mode: session_start skips, self-heal fetches once (parent print path unchanged)", async () => {
		const h = buildHarness({ snippets: [], wing: null, palace: "/tmp/palace" });
		h.setEnv({ PI_SUBAGENT_CHILD: undefined });

		await h.driveSessionStart("print");
		assert.equal(h.wakeUpCalls.length, 0, "print-mode session_start skips the fetch");
		await h.driveTurn();
		assert.equal(h.wakeUpCalls.length, 1, "self-heal still fetches once for a print-mode parent");
	});

	it("child print mode: BOTH session_start and the self-heal path stay silent (the print-child leak)", async () => {
		const h = buildHarness({ snippets: [], wing: null, palace: "/tmp/palace" });
		h.setEnv({ PI_SUBAGENT_CHILD: "1", PI_SUBAGENT_CHILD_AGENT: "worker" });

		await h.driveSessionStart("print");
		await h.driveTurn();
		await h.driveTurn();

		assert.equal(h.wakeUpCalls.length, 0, "print children must not reach wake-up via the self-heal");
	});

	it("child + hatch: wake-up allowed exactly once", async () => {
		const h = buildHarness({ snippets: [], wing: null, palace: "/tmp/palace" });
		h.setEnv({
			PI_SUBAGENT_CHILD: "1",
			PI_MEMPALACE_CHILD_WAKEUP: "1",
		});

		await h.driveSessionStart();
		await h.driveTurn();

		assert.equal(h.wakeUpCalls.length, 1);
		assert.equal(h.state.wakeUpContext, "WAKE-UP-CONTENT");
	});
});

describe("recall contract in children (AC-A2)", () => {
	it("child env with a recall hit: RECALL_CUSTOM_TYPE message and NO systemPrompt key", async () => {
		const h = buildHarness({
			snippets: ["memory snippet about palindromes"],
			wing: null,
			palace: "/tmp/palace",
		});
		h.setEnv({ PI_SUBAGENT_CHILD: "1", PI_SUBAGENT_CHILD_AGENT: "worker" });

		await h.driveSessionStart();
		const r = await h.driveTurn();

		assert.ok(r, "handler returned a result");
		assert.ok(!("systemPrompt" in r), "no systemPrompt key under child gating");
		const message = r.message as { customType: string; content: string } | undefined;
		assert.ok(message, "recall message present");
		assert.equal(message.customType, RECALL_CUSTOM_TYPE);
		assert.ok(message.content.includes("palindrome"), "recall content carried");
	});

	it("parent env with the same recall hit: message AND systemPrompt (parent behavior preserved)", async () => {
		const h = buildHarness({
			snippets: ["memory snippet about palindromes"],
			wing: null,
			palace: "/tmp/palace",
		});
		h.setEnv({ PI_SUBAGENT_CHILD: undefined });

		await h.driveSessionStart();
		const r = await h.driveTurn();

		assert.ok(r && typeof r === "object");
		assert.equal((r.message as { customType: string }).customType, RECALL_CUSTOM_TYPE);
		assert.ok(
			typeof r.systemPrompt === "string" && r.systemPrompt.includes("[MemPalace Session Context]"),
			"parent keeps wake-up systemPrompt alongside recall",
		);
	});
});

describe("per-event hatch evaluation (A3)", () => {
	it("flipping PI_MEMPALACE_CHILD_WAKEUP between turns changes behavior (not factory-frozen)", async () => {
		const h = buildHarness({ snippets: [], wing: null, palace: "/tmp/palace" });
		h.setEnv({ PI_SUBAGENT_CHILD: "1", PI_SUBAGENT_CHILD_AGENT: "worker" });

		await h.driveSessionStart();
		await h.driveTurn();
		assert.equal(h.wakeUpCalls.length, 0, "gated before the flip");

		h.setEnv({ PI_MEMPALACE_CHILD_WAKEUP: "1" });
		await h.driveTurn();
		assert.equal(h.wakeUpCalls.length, 1, "hatch honored at the next event after the flip");
	});
});

describe("one-time gate logs (A6/A3)", () => {
	it("child run logs the gate skip exactly once even across repeated events", async () => {
		const errors: string[] = [];
		const orig = console.error;
		console.error = ((...args: unknown[]) => {
			errors.push(args.map(String).join(" "));
		}) as typeof console.error;
		try {
			const h = buildHarness({ snippets: [], wing: null, palace: "/tmp/palace" });
			h.setEnv({ PI_SUBAGENT_CHILD: "1", PI_SUBAGENT_CHILD_AGENT: "worker" });
			await h.driveSessionStart();
			await h.driveTurn();
			await h.driveTurn();
		} finally {
			console.error = orig;
		}
		const skips = errors.filter((l) => l.includes("MemPalace: child gate active"));
		assert.equal(skips.length, 1, "exactly one gate-skip log line");
		assert.ok(skips[0].includes("child-gated"), "log carries the reason");
	});

	it("hatch run logs the hatch exactly once", async () => {
		const errors: string[] = [];
		const orig = console.error;
		console.error = ((...args: unknown[]) => {
			errors.push(args.map(String).join(" "));
		}) as typeof console.error;
		try {
			const h = buildHarness({ snippets: [], wing: null, palace: "/tmp/palace" });
			h.setEnv({ PI_SUBAGENT_CHILD: "1", PI_MEMPALACE_CHILD_WAKEUP: "1" });
			await h.driveSessionStart();
			await h.driveTurn();
		} finally {
			console.error = orig;
		}
		const hatches = errors.filter((l) => l.includes("MemPalace: child wake-up hatch active"));
		assert.equal(hatches.length, 1, "exactly one hatch log line");
	});
});

// ── session_shutdown mining: quit + session replacement, never reload ───────

describe("session_shutdown mining (quit + session replacement, never reload)", () => {
	const minedSessionFile = () => join(scratch, "sessions", "outgoing.jsonl");

	it("mines the outgoing session dir on quit, new, resume, and fork", async () => {
		for (const reason of ["quit", "new", "resume", "fork"]) {
			const h = buildHarness({ snippets: [], wing: null, palace: "/tmp/palace" });
			h.setEnv({ PI_SUBAGENT_CHILD: undefined });
			await h.driveSessionStart();

			h.driveShutdown(reason, minedSessionFile());

			assert.deepEqual(
				h.mineBackgroundCalls,
				[join(scratch, "sessions")],
				`reason=${reason} must mine dirname(sessionFile) in the background`,
			);
		}
	});

	it("never mines on reload (the same session continues)", async () => {
		const h = buildHarness({ snippets: [], wing: null, palace: "/tmp/palace" });
		h.setEnv({ PI_SUBAGENT_CHILD: undefined });
		await h.driveSessionStart();

		h.driveShutdown("reload", minedSessionFile());

		assert.equal(h.mineBackgroundCalls.length, 0, "reload must not spawn a mine");
	});

	it("mining still works in a gated child (config pre-warm survives the gate, A1)", async () => {
		const h = buildHarness({ snippets: [], wing: null, palace: "/tmp/palace" });
		h.setEnv({ PI_SUBAGENT_CHILD: "1", PI_SUBAGENT_CHILD_AGENT: "worker" });
		await h.driveSessionStart();

		h.driveShutdown("new", minedSessionFile());

		assert.deepEqual(h.mineBackgroundCalls, [join(scratch, "sessions")]);
	});

	it("skips when palace config never resolved (no session_start)", async () => {
		const h = buildHarness({ snippets: [], wing: null, palace: "/tmp/palace" });
		h.setEnv({ PI_SUBAGENT_CHILD: undefined });
		assert.equal(h.state.config, null, "precondition: config unresolved");

		h.driveShutdown("quit", minedSessionFile());

		assert.equal(h.mineBackgroundCalls.length, 0, "no config → no spawn");
	});

	it("skips when there is no session file", async () => {
		const h = buildHarness({ snippets: [], wing: null, palace: "/tmp/palace" });
		h.setEnv({ PI_SUBAGENT_CHILD: undefined });
		await h.driveSessionStart();

		h.driveShutdown("quit", null);

		assert.equal(h.mineBackgroundCalls.length, 0, "no session file → no spawn");
	});

	it("same-manager fork flip: mining the (already-switched) branched path still covers the outgoing session dir", async () => {
		const h = buildHarness({ snippets: [], wing: null, palace: "/tmp/palace" });
		h.setEnv({ PI_SUBAGENT_CHILD: undefined });
		await h.driveSessionStart();

		// createBranchedSession can swap ctx.sessionManager BEFORE teardown, so
		// getSessionFile() at handler time may already be the NEW branched file.
		// Safe: mining is directory-granular (dirname(sessionFile)); the branched
		// file is in the SAME sessions dir as the outgoing parent file, and the
		// mine sweeps unmined files in that dir — so the outgoing parent is swept.
		h.driveShutdown("fork", join(scratch, "sessions", "branched.jsonl"));

		assert.deepEqual(h.mineBackgroundCalls, [join(scratch, "sessions")]);
	});
});
