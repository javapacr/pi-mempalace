/**
 * Wake-up as a conversation message — session lifecycle (2026-11-07 cache-miss fix).
 *
 * Runs the real event handlers over a REAL pi SessionManager (in-memory), so
 * the presence check reads pi's own compaction-aware `buildContextEntries()`
 * rather than a hand-built fake. A second handler set over the same session
 * manager models a restart / `--continue` / resume / reload.
 *
 * Pins:
 *  - a NEW session inserts exactly one wake-up message and fetches once;
 *  - a RESUMED session (wake-up already saved) inserts none and makes no
 *    wake-up CLI call, for every session_start reason;
 *  - compaction: the first run after a compaction that summarised the wake-up
 *    away re-inserts the SAME saved text (no re-fetch) exactly once — also
 *    after two compactions, after compaction + reload, and not at all when
 *    the compaction kept the wake-up in its tail;
 *  - a /tree move to before the wake-up re-inserts the saved text, no fetch;
 *  - a pre-fix (legacy) session gets one fetch and one insert (documented);
 *  - the system prompt never gets a `mempalace` section;
 *  - recall serialization: the message a run sends and pi's replay of the
 *    persisted entry convert to the same provider content.
 */

import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { SessionManager, convertToLlm } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerMempalaceEvents } from "../infrastructure/event-registration";
import { RECALL_CUSTOM_TYPE, SessionState, type SearchResult } from "../domain/types";
import {
	WAKEUP_CUSTOM_TYPE,
	contextNeedsWakeUp,
	findSavedWakeUp,
	formatWakeUpMessage,
	wakeUpTextOf,
} from "../domain/wake-up-message";
import type { WakeUpUseCase } from "../application/wake-up.usecase";
import type { RecallUseCase } from "../application/recall.usecase";
import type { CurationUseCase } from "../application/curation.usecase";
import type { MiningUseCase } from "../application/mining.usecase";

type Handler = (event: unknown, ctx: unknown) => unknown;

interface RunMessage {
	customType: string;
	content: string;
	display: boolean;
	details?: unknown;
}

const ENV_KEYS = [
	"PI_SUBAGENT_CHILD",
	"PI_SUBAGENT_CHILD_AGENT",
	"PI_MEMPALACE_CHILD_WAKEUP",
	"PI_MEMPALACE_CHILD_WAKEUP_AGENTS",
	"MEMPALACE_PALACE",
	"PI_CODING_AGENT_DIR",
] as const;

let scratch = "";
let savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
	scratch = await mkdtemp(join(tmpdir(), "wake-up-message-"));
	await mkdir(join(scratch, "agent"), { recursive: true });
	savedEnv = {};
	for (const k of ENV_KEYS) {
		savedEnv[k] = process.env[k];
		delete process.env[k];
	}
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

const newSession = () => SessionManager.inMemory(scratch);

/** A minimal assistant reply; the context rules ignore its shape. */
function appendAssistant(sm: SessionManager, text: string): string {
	return sm.appendMessage({
		role: "assistant",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	} as unknown as Parameters<SessionManager["appendMessage"]>[0]);
}

/**
 * One pi extension runtime over `sm`. Creating a second one over the same
 * session manager models a restart, `--continue`, resume or reload.
 */
function runtimeOver(
	sm: SessionManager,
	opts: {
		/** CLI result; an array yields one element per call (last one repeats). */
		wakeUpText?: string | null | Array<string | null>;
		recallHits?: SearchResult;
	} = {},
) {
	const state = new SessionState();
	const handlers = new Map<string, Handler[]>();
	const wakeUpCalls: string[] = [];
	const sent: unknown[] = [];

	const pi = {
		on: (name: string, fn: Handler) => {
			handlers.set(name, [...(handlers.get(name) ?? []), fn]);
		},
		events: { on: () => () => {} },
		registerCommand: () => {},
		sendMessage: (message: unknown) => {
			sent.push(message);
		},
	} as unknown as ExtensionAPI;

	const wakeUp = {
		execute: async (cwd: string) => {
			wakeUpCalls.push(cwd);
			const t = opts.wakeUpText;
			if (Array.isArray(t)) return t[Math.min(wakeUpCalls.length, t.length) - 1];
			return t === undefined ? "L0+L1 v1" : t;
		},
	} as unknown as WakeUpUseCase;
	const recallHits = opts.recallHits ?? { snippets: [], wing: null, palace: "/p" };
	const recall = { execute: async () => recallHits } as unknown as RecallUseCase;

	registerMempalaceEvents(
		pi,
		state,
		wakeUp,
		recall,
		{ buildPrompt: async () => ({ prompt: "x" }) } as unknown as CurationUseCase,
		{ mineSync: async () => {}, mineBackground: () => {} } as unknown as MiningUseCase,
		new Proxy({}, { get: () => () => Promise.resolve() }) as never,
	);

	const ctx = (mode: string) => ({
		mode,
		cwd: scratch,
		sessionManager: sm,
		ui: { notify: () => {} },
	});
	const run = async (name: string, event: unknown, mode = "interactive") => {
		const results: unknown[] = [];
		for (const fn of handlers.get(name) ?? []) results.push(await fn(event, ctx(mode)));
		return results;
	};

	return {
		state,
		wakeUpCalls,
		sent,
		sessionStart: (reason = "startup", mode?: string) =>
			run("session_start", { type: "session_start", reason }, mode),
		/**
		 * One run, persisted like pi's _prepareRun: the user prompt, then the
		 * handler messages in registration order, then an assistant reply.
		 */
		turn: async (prompt = "a prompt long enough for recall", mode?: string) => {
			const sections: Record<string, string> = {};
			const results = (await run(
				"before_agent_start",
				{ prompt, systemPrompt: "BASE", systemPromptOptions: { sections } },
				mode,
			)) as Array<{ message?: RunMessage; systemPrompt?: string } | undefined>;
			const messages = results.flatMap((r) => (r?.message ? [r.message] : []));
			const userId = sm.appendMessage({
				role: "user",
				content: [{ type: "text", text: prompt }],
				timestamp: Date.now(),
			});
			for (const m of messages)
				sm.appendCustomMessageEntry(m.customType, m.content, m.display, m.details);
			const assistantId = appendAssistant(sm, "ok");
			return {
				messages,
				sections,
				systemPromptForced: results.some((r) => r?.systemPrompt !== undefined),
				userId,
				assistantId,
			};
		},
	};
}

const wakeUps = (messages: RunMessage[]) =>
	messages.filter((m) => m.customType === WAKEUP_CUSTOM_TYPE);
const savedWakeUps = (sm: SessionManager) =>
	sm.getEntries().filter((e) => wakeUpTextOf(e) !== null).length;
const contextWakeUps = (sm: SessionManager) =>
	sm.buildContextEntries().filter((e) => wakeUpTextOf(e) !== null).length;
const framed = formatWakeUpMessage;

// ── pure entry logic ─────────────────────────────────────────────────────────

describe("wake-up entry logic (pure)", () => {
	it("reads both persisted shapes; ignores other custom types", () => {
		assert.equal(
			wakeUpTextOf({ type: "custom_message", customType: WAKEUP_CUSTOM_TYPE, content: "a" }),
			"a",
		);
		assert.equal(
			wakeUpTextOf({
				type: "message",
				message: {
					role: "custom",
					customType: WAKEUP_CUSTOM_TYPE,
					content: [{ type: "text", text: "b" }],
				},
			}),
			"b",
		);
		assert.equal(
			wakeUpTextOf({ type: "custom_message", customType: RECALL_CUSTOM_TYPE, content: "c" }),
			null,
		);
		assert.equal(wakeUpTextOf(null), null);
	});

	it("findSavedWakeUp returns the latest saved text, null when none", () => {
		const w = (content: string) => ({
			type: "custom_message",
			customType: WAKEUP_CUSTOM_TYPE,
			content,
		});
		assert.equal(findSavedWakeUp([]), null);
		assert.equal(findSavedWakeUp([w("old"), { type: "compaction" }, w("new")]), "new");
	});

	it("contextNeedsWakeUp: true only when no wake-up is among the context entries", () => {
		const w = { type: "custom_message", customType: WAKEUP_CUSTOM_TYPE, content: "x" };
		const user = { type: "message", message: { role: "user", content: "hi" } };
		assert.equal(contextNeedsWakeUp([]), true);
		assert.equal(contextNeedsWakeUp([user]), true);
		assert.equal(contextNeedsWakeUp([{ type: "compaction" }, w, user]), false);
	});

	it("formatWakeUpMessage frames the CLI text as background memory", () => {
		const f = framed("TEXT");
		assert.ok(f.startsWith("<mempalace-wakeup>\n"));
		assert.ok(f.includes("\nTEXT\n"));
		assert.ok(f.endsWith("</mempalace-wakeup>"));
	});
});

// ── session lifecycle over a real SessionManager ─────────────────────────────

describe("new session", () => {
	it("inserts exactly one wake-up message across several runs; one CLI call; no section", async () => {
		const sm = newSession();
		const p = runtimeOver(sm);
		await p.sessionStart("startup");
		const r1 = await p.turn();
		const r2 = await p.turn();
		const r3 = await p.turn("yes");

		assert.deepEqual(wakeUps(r1.messages).map((m) => m.content), [framed("L0+L1 v1")]);
		assert.deepEqual([...wakeUps(r2.messages), ...wakeUps(r3.messages)], []);
		assert.equal(savedWakeUps(sm), 1, "exactly one wake-up in the session");
		assert.equal(p.wakeUpCalls.length, 1, "fetched once, at session_start");
		for (const r of [r1, r2, r3]) {
			assert.deepEqual(r.sections, {}, "system prompt gets no mempalace section");
			assert.equal(r.systemPromptForced, false);
		}
		assert.deepEqual(p.sent, [], "nothing sent outside the run (no session_start message)");
	});

	it("handoff / new session (reason new) over an empty session fetches fresh", async () => {
		const p = runtimeOver(newSession(), { wakeUpText: "fresh" });
		await p.sessionStart("new");
		const r = await p.turn();
		assert.equal(p.wakeUpCalls.length, 1);
		assert.deepEqual(wakeUps(r.messages).map((m) => m.content), [framed("fresh")]);
	});
});

describe("resumed session", () => {
	for (const reason of ["startup", "resume", "reload", "fork"]) {
		it(`session_start(${reason}) with a saved wake-up: no CLI call, no new message`, async () => {
			const sm = newSession();
			const first = runtimeOver(sm, { wakeUpText: "v1" });
			await first.sessionStart("startup");
			await first.turn();

			// Restart: a NEW runtime over the same session. The diary moved the
			// L1 story on — a re-fetch would return different text.
			const second = runtimeOver(sm, { wakeUpText: "v2 (changed)" });
			await second.sessionStart(reason);
			const r1 = await second.turn();
			const r2 = await second.turn();

			assert.equal(second.wakeUpCalls.length, 0, "resume makes no wake-up CLI call");
			assert.deepEqual([...wakeUps(r1.messages), ...wakeUps(r2.messages)], []);
			assert.equal(savedWakeUps(sm), 1, "the saved message stays the only one");
			assert.equal(second.state.wakeUpContext, framed("v1"), "saved text reused");
		});
	}

	it("print-mode --continue: no fetch, no new message", async () => {
		const sm = newSession();
		const first = runtimeOver(sm, { wakeUpText: "v1" });
		await first.sessionStart("startup", "print");
		await first.turn(undefined, "print"); // self-heal fetch + insert
		const second = runtimeOver(sm, { wakeUpText: "v2" });
		await second.sessionStart("startup", "print");
		const r = await second.turn(undefined, "print");
		assert.equal(first.wakeUpCalls.length, 1);
		assert.equal(second.wakeUpCalls.length, 0);
		assert.deepEqual(wakeUps(r.messages), []);
	});

	it("legacy session (from before this change, no saved wake-up): one fetch, one insert — the documented exception", async () => {
		const sm = newSession();
		sm.appendMessage({ role: "user", content: [{ type: "text", text: "old" }], timestamp: 1 });
		appendAssistant(sm, "old reply");
		const p = runtimeOver(sm, { wakeUpText: "now" });
		await p.sessionStart("resume");
		const r1 = await p.turn();
		const r2 = await p.turn();
		assert.equal(p.wakeUpCalls.length, 1);
		assert.deepEqual(wakeUps(r1.messages).map((m) => m.content), [framed("now")]);
		assert.deepEqual(wakeUps(r2.messages), []);
	});
});

describe("compaction", () => {
	it("compaction that summarised the wake-up away: next run re-inserts the SAME text once, no re-fetch", async () => {
		const sm = newSession();
		const p = runtimeOver(sm, { wakeUpText: ["v1", "v2"] });
		await p.sessionStart();
		await p.turn();
		const kept = await p.turn();
		sm.appendCompaction("summary", kept.userId, 1000); // wake-up (turn 1) summarised away
		assert.equal(contextWakeUps(sm), 0);

		const r1 = await p.turn();
		const r2 = await p.turn();
		assert.equal(p.wakeUpCalls.length, 1, "no re-fetch on compaction");
		assert.deepEqual(wakeUps(r1.messages).map((m) => m.content), [framed("v1")]);
		assert.deepEqual(wakeUps(r2.messages), []);
		assert.equal(contextWakeUps(sm), 1, "exactly one wake-up in the compacted context");
		assert.deepEqual(p.sent, [], "no queued copy — the entries alone decide");
	});

	it("compaction that KEPT the wake-up in its tail: no second copy", async () => {
		const sm = newSession();
		const p = runtimeOver(sm);
		await p.sessionStart();
		const first = await p.turn();
		await p.turn();
		sm.appendCompaction("summary", first.userId, 1000); // keeps turn 1 (with the wake-up)
		const r = await p.turn();
		assert.deepEqual(wakeUps(r.messages), []);
		assert.equal(contextWakeUps(sm), 1);
	});

	it("two compactions before the next run: exactly one re-insert", async () => {
		const sm = newSession();
		const p = runtimeOver(sm);
		await p.sessionStart();
		await p.turn();
		const t2 = await p.turn();
		sm.appendCompaction("summary 1", t2.userId, 1000);
		sm.appendCompaction("summary 2", t2.userId, 1000);
		const r = await p.turn();
		assert.equal(wakeUps(r.messages).length, 1);
		assert.equal(contextWakeUps(sm), 1);
	});

	it("compaction, then reload/restart before the next run: one re-insert of the saved text, no fetch", async () => {
		const sm = newSession();
		const first = runtimeOver(sm, { wakeUpText: "v1" });
		await first.sessionStart();
		await first.turn();
		const t2 = await first.turn();
		sm.appendCompaction("summary", t2.userId, 1000);

		const second = runtimeOver(sm, { wakeUpText: "v2" });
		await second.sessionStart("reload");
		const r = await second.turn();
		assert.equal(second.wakeUpCalls.length, 0, "no re-fetch");
		assert.deepEqual(wakeUps(r.messages).map((m) => m.content), [framed("v1")]);
		assert.equal(contextWakeUps(sm), 1);
	});

	it("gated child: nothing re-inserted after compaction", async () => {
		process.env.PI_SUBAGENT_CHILD = "1";
		const sm = newSession();
		sm.appendCustomMessageEntry(WAKEUP_CUSTOM_TYPE, "forked", true);
		const t = sm.appendMessage({ role: "user", content: [{ type: "text", text: "q" }], timestamp: 1 });
		appendAssistant(sm, "a");
		sm.appendCompaction("summary", t, 1000);
		const p = runtimeOver(sm);
		await p.sessionStart();
		const r = await p.turn();
		assert.deepEqual(wakeUps(r.messages), []);
		assert.equal(p.wakeUpCalls.length, 0);
	});
});

describe("tree moves", () => {
	it("/tree to before the wake-up: the saved text is re-inserted, no fetch", async () => {
		const sm = newSession();
		const root = sm.appendMessage({ role: "user", content: [{ type: "text", text: "pre" }], timestamp: 1 });
		appendAssistant(sm, "pre reply");
		const p = runtimeOver(sm, { wakeUpText: ["v1", "v2"] });
		await p.sessionStart();
		await p.turn(); // wake-up lands here, after `root`
		sm.branch(root); // navigate back to before the wake-up
		const r = await p.turn();
		assert.equal(p.wakeUpCalls.length, 1);
		assert.deepEqual(wakeUps(r.messages).map((m) => m.content), [framed("v1")]);
	});
});

describe("self-heal retry", () => {
	it("session_start fetch failed: the first run's retry fetches and inserts the message once", async () => {
		const p = runtimeOver(newSession(), { wakeUpText: [null, "healed"] });
		await p.sessionStart();
		const r1 = await p.turn();
		const r2 = await p.turn();
		assert.equal(p.wakeUpCalls.length, 2);
		assert.deepEqual(wakeUps(r1.messages).map((m) => m.content), [framed("healed")]);
		assert.deepEqual(wakeUps(r2.messages), []);
	});

	it("session_start fetch failed and the retry fails too: no message, no further retries", async () => {
		const p = runtimeOver(newSession(), { wakeUpText: null });
		await p.sessionStart();
		const r1 = await p.turn();
		const r2 = await p.turn();
		assert.equal(p.wakeUpCalls.length, 2, "one-shot retry at the first run");
		assert.deepEqual([...wakeUps(r1.messages), ...wakeUps(r2.messages)], []);
	});
});

// ── recall serialization stability ───────────────────────────────────────────

describe("recall message serialization", () => {
	it("the run's recall message and pi's replay of the persisted entry give the same provider content", async () => {
		const hits: SearchResult = {
			snippets: ["SESSION:2026-11-07|cache.fix", "another memory"],
			wing: "wing_pi",
			palace: "/palace",
		};
		const smA = newSession();
		const a = runtimeOver(smA, { recallHits: hits });
		const b = runtimeOver(newSession(), { recallHits: hits });
		await a.sessionStart();
		await b.sessionStart();
		const prompt = "explain the prompt cache misses from earlier";
		const ra = (await a.turn(prompt)).messages.find((m) => m.customType === RECALL_CUSTOM_TYPE);
		const rb = (await b.turn(prompt)).messages.find((m) => m.customType === RECALL_CUSTOM_TYPE);
		assert.ok(ra && rb);
		assert.deepEqual(ra, rb, "same snippets → byte-identical message (no clock or counter in it)");

		// First call: pi sends the in-memory run message. Later calls: pi
		// rebuilds it from the persisted entry (its own timestamp). Providers
		// send role + content only, so those must match exactly.
		const live = { role: "custom" as const, ...ra, timestamp: Date.now() };
		const replay = smA
			.buildSessionContext()
			.messages.find(
				(m) => m.role === "custom" && (m as { customType?: string }).customType === RECALL_CUSTOM_TYPE,
			);
		assert.ok(replay, "recall replayed from the session");
		const [l] = convertToLlm([live]);
		const [r] = convertToLlm([replay]);
		assert.deepEqual({ role: l.role, content: l.content }, { role: r.role, content: r.content });
		assert.ok(!JSON.stringify(l.content).includes("wing_pi"), "details never reach the model content");
	});
});
