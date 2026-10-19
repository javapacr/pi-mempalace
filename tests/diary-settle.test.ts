/**
 * W1 — settle diary nudge (H1).
 *
 * Covers:
 *  - one hidden followUp nudge per qualifying tui settle; the nudge's own
 *    run settles without a second nudge (I1, D7, R7)
 *  - every skip gate: aborted settle, already-diarised run, no diary tool,
 *    subagent child, non-tui modes, diary_on_settle false (I1, D3/D4/D10)
 *  - diary-tool detection by suffix across active ∪ all tools (E8)
 *  - the handoff-in-progress window: raised by handoff_tool_start and
 *    tui_filled_handoff (D9), cleared by handoff_command_complete or the
 *    next interactive input only (D8)
 *  - pending-nudge flag: read at agent_end, read-and-cleared at
 *    agent_settled (D11); session_start reset; curation cadence intact (I5)
 *  - checkpoint yield: the settle after a run that just queued the curation
 *    checkpoint sends no nudge (D17)
 */

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	buildDiaryHarness,
	DIARY_TOOL_NAME,
	restoreEnv,
	setupHermeticEnv,
	writeProjectSettings,
	type DiaryHarnessOptions,
} from "./helpers/diary-harness";
import {
	SETTLE_NUDGE_CUSTOM_TYPE,
	SETTLE_NUDGE_TEXT,
} from "../domain/diary-nudge";
import { HANDOFF_CHANNELS } from "../domain/handoff-contract";

beforeEach(setupHermeticEnv);
afterEach(restoreEnv);

const SESSION_FILE = "/tmp/session.jsonl";

describe("settle nudge (W1)", () => {
	it("H1 sends one hidden followUp nudge on a qualifying tui settle", async () => {
		const h = buildDiaryHarness();
		await h.sessionStart();
		await h.agentEnd(SESSION_FILE);

		await h.settle();

		assert.equal(h.sentMessages.length, 1);
		assert.deepEqual(h.sentMessages[0].message, {
			customType: SETTLE_NUDGE_CUSTOM_TYPE,
			content: SETTLE_NUDGE_TEXT,
			display: false,
		});
		assert.deepEqual(h.sentMessages[0].options, {
			triggerTurn: true,
			deliverAs: "followUp",
		});
	});

	it("H1 nudge run settles without a second nudge", async () => {
		const h = buildDiaryHarness();
		await h.sessionStart();
		await h.agentEnd(SESSION_FILE);
		await h.settle(); // qualifying settle → nudge, pending-nudge flag set
		await h.agentEnd(SESSION_FILE); // the nudge's own run ends
		await h.settle(); // its settle must stay quiet

		assert.equal(h.sentMessages.length, 1);
	});

	it("H1 skips: aborted settle", async () => {
		const h = buildDiaryHarness();
		await h.sessionStart();
		await h.agentEnd(SESSION_FILE);

		await h.settle({ aborted: true });

		assert.equal(h.sentMessages.length, 0);
	});

	it("H1 skips: diary already written this run", async () => {
		const h = buildDiaryHarness();
		await h.sessionStart();
		await h.toolStart(DIARY_TOOL_NAME);

		// The diary run ends before its settle: agent_end must NOT clear the
		// mark — only the settle consumes it (D11, R7).
		await h.agentEnd(SESSION_FILE);
		await h.settle();

		assert.equal(h.sentMessages.length, 0);
		assert.equal(
			h.state.diaryWrittenThisRun,
			false,
			"agent_settled clears the mark even on a skipped settle",
		);

		// A fresh run after that settle must nudge: the mark must not leak
		// past the settle that consumed it (D11).
		await h.agentEnd(SESSION_FILE);
		await h.settle();

		assert.equal(h.sentMessages.length, 1);
	});

	it("H1 skips: no diary tool registered", async () => {
		const h = buildDiaryHarness({
			activeTools: [],
			allTools: [{ name: "mempalace-personal_mempalace_recall" }],
		});
		await h.sessionStart();
		await h.agentEnd(SESSION_FILE);

		await h.settle();

		assert.equal(h.sentMessages.length, 0);
	});

	it("H1 skips: subagent child", async () => {
		const h = buildDiaryHarness();
		await h.sessionStart();
		await h.agentEnd(SESSION_FILE);
		// Per-event gate: the child env arrives only at the settle (PRD A3).
		process.env.PI_SUBAGENT_CHILD = "1";

		await h.settle();

		assert.equal(h.sentMessages.length, 0);
	});

	it("H1 skips: non-tui modes print json rpc", async () => {
		const h = buildDiaryHarness();

		for (const mode of ["print", "json", "rpc"]) {
			await h.sessionStart(mode);
			await h.agentEnd(SESSION_FILE);
			await h.settle({ mode });
		}

		assert.equal(h.sentMessages.length, 0);
	});

	it("H1 skips: diary_on_settle false", async () => {
		await writeProjectSettings({ diary_on_settle: false });
		const h = buildDiaryHarness();
		await h.sessionStart();
		await h.agentEnd(SESSION_FILE);

		await h.settle();

		assert.equal(h.sentMessages.length, 0);
	});

	it("H1 detects the diary tool by suffix in active or all tools", async () => {
		const matching: ReadonlyArray<
			readonly [label: string, opts: DiaryHarnessOptions]
		> = [
			[
				"this profile's prefix, via active tools",
				{ activeTools: ["unrelated_tool", DIARY_TOOL_NAME] },
			],
			[
				"another palace's prefix, via active tools",
				{ activeTools: ["mempalace-work_mempalace_diary_write"] },
			],
			[
				"no prefix at all, via active tools",
				{ activeTools: ["mempalace_diary_write"] },
			],
			[
				"no prefix at all, via all tools",
				{ activeTools: [], allTools: [{ name: "mempalace_diary_write" }] },
			],
		];
		for (const [label, opts] of matching) {
			const h = buildDiaryHarness(opts);
			await h.sessionStart();
			await h.agentEnd(SESSION_FILE);
			await h.settle();
			assert.equal(h.sentMessages.length, 1, `${label} must match`);
		}

		// Near-misses share the prefix but not the suffix — matching them
		// would be the exact-name trap that killed pi-handoff's reminder (E8).
		const nearMiss = buildDiaryHarness({
			activeTools: ["mempalace_diary_writer"],
			allTools: [{ name: "mempalace_diary_write_v2" }],
		});
		await nearMiss.sessionStart();
		await nearMiss.agentEnd(SESSION_FILE);
		await nearMiss.settle();
		assert.equal(nearMiss.sentMessages.length, 0, "near-misses must not match");
	});

	it("H1 ignores non-diary tool calls", async () => {
		const h = buildDiaryHarness();
		await h.sessionStart();
		await h.agentEnd(SESSION_FILE);
		// Ordinary tool calls must not mark the run as already-diarised —
		// only a name ending in mempalace_diary_write does (D11).
		await h.toolStart("read");
		await h.toolStart("bash");

		await h.settle();

		assert.equal(h.sentMessages.length, 1);
	});

	it("H1 stays quiet and does not throw without tool getters", async () => {
		// Hosts without a usable tool registry (older pi, minimal harnesses)
		// must leave the nudge inert, never throw from a hook (D12, R3).
		for (const toolGetters of ["missing", "throw"] as const) {
			const h = buildDiaryHarness({ toolGetters });
			await h.sessionStart();
			await h.agentEnd(SESSION_FILE);

			await h.settle(); // must not throw

			assert.equal(
				h.sentMessages.length,
				0,
				`${toolGetters} getters read as no diary tool`,
			);
		}
	});

	it("H1 aborted guard tolerates absent and non-boolean aborted", async () => {
		// Pre-1.1 host (D10): the event carries no aborted field at all — the
		// structural guard must read that as a normal (non-aborted) settle.
		const absent = buildDiaryHarness();
		await absent.sessionStart();
		await absent.agentEnd(SESSION_FILE);
		await absent.settle({ omitAborted: true });

		assert.equal(absent.sentMessages.length, 1, "absent aborted reads false");

		// A non-boolean aborted must not read as aborted: the guard is the
		// strict `=== true`, not a truthiness check (D10).
		const nonBoolean = buildDiaryHarness();
		await nonBoolean.sessionStart();
		await nonBoolean.agentEnd(SESSION_FILE);
		await nonBoolean.settle({ aborted: "true" });

		assert.equal(nonBoolean.sentMessages.length, 1, '"true" is not aborted');
	});

	it("H1 quiet during handoff: handoff_tool_start", async () => {
		const h = buildDiaryHarness();
		await h.sessionStart();
		await h.agentEnd(SESSION_FILE);
		// W2: the continue tool fires inside a streaming run, and the
		// handoff_tool_start listener now sends the H2 nudge — this test's
		// subject stays H1, so stage the run and count only settle nudges.
		await h.agentStart();
		h.emitBus(HANDOFF_CHANNELS.toolStart, {
			goal: "x",
			command: "/continue",
		});

		await h.settle();

		assert.equal(
			h.sentMessages.filter(
				(m) => m.message.customType === SETTLE_NUDGE_CUSTOM_TYPE,
			).length,
			0,
			"H1 stays quiet while a continue-tool handoff is under way (D8/D9)",
		);
	});

	it("H1 quiet during handoff: tui_filled_handoff", async () => {
		const h = buildDiaryHarness();
		await h.sessionStart();
		await h.agentEnd(SESSION_FILE);
		h.emitBus(HANDOFF_CHANNELS.tuiFilledHandoff, {
			goal: "x",
			command: "/continue",
		});

		await h.settle();

		assert.equal(h.sentMessages.length, 0);
	});

	it("H1 resumes after handoff_command_complete", async () => {
		const h = buildDiaryHarness();
		await h.sessionStart();
		await h.agentEnd(SESSION_FILE);
		// Mid-stream staging (W2): the toolStart listener sends the H2 nudge
		// without claiming the pending-nudge flag; this test's subject is the
		// settle nudge resuming once the window closes.
		await h.agentStart();
		h.emitBus(HANDOFF_CHANNELS.toolStart, {});
		h.emitBus(HANDOFF_CHANNELS.commandComplete, { trigger: "continue" });

		await h.settle();

		assert.equal(
			h.sentMessages.filter(
				(m) => m.message.customType === SETTLE_NUDGE_CUSTOM_TYPE,
			).length,
			1,
			"exactly one settle nudge once the handoff completes",
		);
	});

	it("H1 resumes after interactive input only", async () => {
		const h = buildDiaryHarness();
		await h.sessionStart();
		await h.agentEnd(SESSION_FILE);
		h.emitBus(HANDOFF_CHANNELS.tuiFilledHandoff, {});

		const rpcResult = await h.input("rpc"); // non-interactive input must NOT close the window
		assert.equal(
			rpcResult,
			undefined,
			"the input handler must return nothing (a result would transform or swallow the input)",
		);
		await h.settle();
		assert.equal(h.sentMessages.length, 0);

		const interactiveResult = await h.input("interactive");
		assert.equal(
			interactiveResult,
			undefined,
			"the input handler must return nothing (a result would transform or swallow the input)",
		);
		await h.settle();
		assert.equal(h.sentMessages.length, 1);
	});

	it("pending-nudge flag: agent_end reads, agent_settled clears", async () => {
		const h = buildDiaryHarness();
		await h.sessionStart();
		await h.agentEnd(SESSION_FILE); // real run → count 1
		await h.settle(); // nudge; pending flag set
		assert.ok(h.state.nudgeRunPending);

		await h.agentEnd(SESSION_FILE); // nudge run's agent_end
		assert.equal(h.state.conversationCount, 1, "nudge run must not count");
		assert.ok(
			h.state.nudgeRunPending,
			"agent_end must only read the flag (R7)",
		);

		await h.settle(); // nudge run's settle consumes the flag
		assert.equal(h.state.nudgeRunPending, false);
		assert.equal(h.sentMessages.length, 1, "no second nudge");
	});

	it("session_start resets handoff and pending-nudge flags", async () => {
		const h = buildDiaryHarness();
		await h.sessionStart();
		await h.agentEnd(SESSION_FILE);
		await h.settle(); // pending-nudge flag set
		h.emitBus(HANDOFF_CHANNELS.tuiFilledHandoff, {}); // handoff window raised (D9 leg — toolStart now carries W2's nudge, covered in diary-handoff.test.ts)
		await h.toolStart(DIARY_TOOL_NAME); // already-diarised mark
		// checkpointQueuedThisRun never coexists with nudgeRunPending through the
		// drivers — a queued checkpoint makes its own settle yield (D17) — so it
		// is set directly; the point here is reset() coverage.
		h.state.checkpointQueuedThisRun = true;
		assert.ok(h.state.nudgeRunPending);
		assert.ok(h.state.handoffInProgress);
		assert.ok(h.state.diaryWrittenThisRun);
		assert.ok(h.state.checkpointQueuedThisRun);

		await h.sessionStart();

		assert.equal(h.state.nudgeRunPending, false);
		assert.equal(h.state.handoffInProgress, false);
		assert.equal(
			h.state.diaryWrittenThisRun,
			false,
			"the per-run diary mark resets too (D11)",
		);
		assert.equal(
			h.state.checkpointQueuedThisRun,
			false,
			"the checkpoint-yield mark resets too (D17)",
		);
		// All four flags cleared: a stale pending flag would read this settle as
		// a nudge run, a stale handoff flag, diary mark or checkpoint mark would
		// suppress it — either way the count would stay at 1 instead of 2.
		await h.settle();
		assert.equal(h.sentMessages.length, 2);
	});

	it("H1 yields to a queued curation checkpoint", async () => {
		const h = buildDiaryHarness();
		await h.sessionStart();

		// Real exchanges below the interval: every settle nudges — a run whose
		// agent_end queued no checkpoint never yields (D17).
		for (let i = 0; i < 14; i++) {
			await h.agentEnd(SESSION_FILE);
			await h.settle();
			await h.agentEnd(SESSION_FILE); // the nudge's run
			await h.settle();
		}
		assert.equal(h.state.conversationCount, 14);
		assert.equal(
			h.sentMessages.filter((m) => m.message.customType === SETTLE_NUDGE_CUSTOM_TYPE)
				.length,
			14,
			"settles without a queued checkpoint still nudge",
		);

		// 15th real exchange: agent_end queues the curation checkpoint…
		await h.agentEnd(SESSION_FILE);
		assert.ok(
			h.sentMessages.some(
				(m) =>
					m.message.customType === "mempalace-autosave" &&
					m.options.deliverAs === "nextTurn",
			),
			"the 15th exchange queues the checkpoint",
		);
		// …so its settle sends NO nudge: on pi ≥ 1.2 a nudge run would drain the
		// pending nextTurn checkpoint into itself, and "Start no new work" would
		// fight the checkpoint's curation instruction (D17).
		await h.settle();
		assert.equal(
			h.sentMessages.filter((m) => m.message.customType === SETTLE_NUDGE_CUSTOM_TYPE)
				.length,
			14,
			"the settle after a queued checkpoint stays quiet",
		);
		assert.equal(
			h.state.checkpointQueuedThisRun,
			false,
			"the yielding settle consumed the flag",
		);

		// The next real exchange's settle nudges again.
		await h.agentEnd(SESSION_FILE);
		await h.settle();
		assert.equal(
			h.sentMessages.filter((m) => m.message.customType === SETTLE_NUDGE_CUSTOM_TYPE)
				.length,
			15,
			"the next real exchange nudges again",
		);
		// Cadence unchanged: the yield touches neither the count nor the
		// checkpoint — 16 real exchanges, exactly one checkpoint (at 15).
		assert.equal(h.state.conversationCount, 16, "real exchanges still count");
		assert.equal(
			h.sentMessages.filter((m) => m.message.customType === "mempalace-autosave")
				.length,
			1,
			"one checkpoint per save_interval",
		);
	});

	it("curation still fires every save_interval real exchanges with nudges interleaved", async () => {
		const h = buildDiaryHarness();
		await h.sessionStart();

		for (let i = 0; i < 15; i++) {
			await h.agentEnd(SESSION_FILE); // real exchange
			await h.settle(); // nudge fires, pending flag set — except the 15th: it yields to the queued checkpoint
			await h.agentEnd(SESSION_FILE); // the nudge's run (a plain run after the yielding settle)
			await h.settle(); // stays quiet — except after the yielding settle, where the next nudge fires
		}

		assert.equal(
			h.state.conversationCount,
			16,
			"only real exchanges count — the run after the yielding settle is one too",
		);
		const checkpoints = h.sentMessages.filter(
			(m) => m.message.customType === "mempalace-autosave",
		);
		assert.equal(checkpoints.length, 1, "checkpoint exactly at the 15th");
		assert.equal(checkpoints[0].options.deliverAs, "nextTurn");
		const nudges = h.sentMessages.filter(
			(m) => m.message.customType === SETTLE_NUDGE_CUSTOM_TYPE,
		);
		assert.equal(
			nudges.length,
			15,
			"14 settles nudge; the 15th yields to its checkpoint, and the settle after that run's trailing agent_end nudges in its place",
		);
	});

	it("nudge-run agent_end leaves conversationCount unchanged and sends no checkpoint", async () => {
		const h = buildDiaryHarness();
		await h.sessionStart();
		for (let i = 0; i < 14; i++) await h.agentEnd(SESSION_FILE); // one short

		await h.settle(); // nudge → pending flag set
		await h.agentEnd(SESSION_FILE); // a bare increment would hit 15 and re-checkpoint
		await h.settle();

		assert.equal(h.state.conversationCount, 14);
		assert.equal(h.sentMessages.length, 1, "only the nudge, no checkpoint");
		assert.equal(h.sentMessages[0].message.customType, SETTLE_NUDGE_CUSTOM_TYPE);
	});

	it("H1 threshold: a settle below the default three tool calls sends nothing, reaching it nudges", async () => {
		// "default" keeps the real settings value (3) — the harness override
		// is what lets the W1/W2 tests above settle tool-free runs (I7).
		const h = buildDiaryHarness({ settleMinToolCalls: "default" });
		await h.sessionStart();

		// Two tool calls < 3: the qualifying settle stays quiet (D18).
		await h.toolStart("read");
		await h.toolStart("bash");
		await h.agentEnd(SESSION_FILE);
		await h.settle();
		assert.equal(h.sentMessages.length, 0, "two calls sit below the default");

		// The third call — in the next run — crosses the threshold.
		await h.toolStart("edit");
		await h.agentEnd(SESSION_FILE);
		await h.settle();
		assert.equal(h.sentMessages.length, 1, "the third call crosses the threshold");
		assert.equal(h.sentMessages[0].message.customType, SETTLE_NUDGE_CUSTOM_TYPE);
	});

	it("H1 threshold: zero nudges a tool-free run", async () => {
		const h = buildDiaryHarness({ settleMinToolCalls: 0 });
		await h.sessionStart();
		await h.agentEnd(SESSION_FILE);

		await h.settle();

		assert.equal(h.sentMessages.length, 1, "0 restores every-settle (D18)");
	});

	it("H1 threshold: short runs add up across skipped settles", async () => {
		const h = buildDiaryHarness({ settleMinToolCalls: "default" }); // 3
		await h.sessionStart();

		// Three one-call runs: the first two settles sit below the threshold
		// and keep the count; the third reaches it (D18, amended — W3.R3).
		for (let run = 1; run <= 3; run++) {
			await h.toolStart("read");
			await h.agentEnd(SESSION_FILE);
			await h.settle();
			assert.equal(
				h.sentMessages.length,
				run === 3 ? 1 : 0,
				`run ${run}: ${run} accumulated call(s)`,
			);
		}
		// A tool-free run in between adds nothing but loses nothing either.
		const g = buildDiaryHarness({ settleMinToolCalls: "default" });
		await g.sessionStart();
		await g.toolStart("read");
		await g.toolStart("bash");
		await g.agentEnd(SESSION_FILE);
		await g.settle();
		await g.agentEnd(SESSION_FILE); // tool-free
		await g.settle();
		assert.equal(g.state.toolCallsSinceDiary, 2, "the tool-free settle kept the count");
		assert.equal(g.sentMessages.length, 0);
	});

	it("H1 threshold: an aborted or handoff-window settle keeps the count", async () => {
		const h = buildDiaryHarness({ settleMinToolCalls: "default" });
		await h.sessionStart();
		await h.toolStart("read");
		await h.toolStart("bash");
		await h.toolStart("edit");
		await h.agentEnd(SESSION_FILE);
		await h.settle({ aborted: true });
		assert.equal(h.sentMessages.length, 0, "aborted settles never nudge");
		assert.equal(h.state.toolCallsSinceDiary, 3, "the aborted settle kept the count");

		// The next qualifying settle — even of a tool-free run — collects it.
		await h.agentEnd(SESSION_FILE);
		await h.settle();
		assert.equal(h.sentMessages.length, 1);
		assert.equal(h.sentMessages[0].message.customType, SETTLE_NUDGE_CUSTOM_TYPE);

		// Handoff window: the tui_filled_handoff leg raises it WITHOUT a nudge,
		// so nothing zeroes the count there; the windowed settle must keep it.
		const w = buildDiaryHarness({ settleMinToolCalls: "default" });
		await w.sessionStart();
		await w.toolStart("read");
		await w.toolStart("bash");
		await w.toolStart("edit");
		await w.agentEnd(SESSION_FILE);
		w.emitBus(HANDOFF_CHANNELS.tuiFilledHandoff, {});
		await w.settle();
		assert.equal(w.sentMessages.length, 0, "handoff-window settles never nudge");
		assert.equal(w.state.toolCallsSinceDiary, 3, "the handoff-window settle kept the count");
		w.emitBus(HANDOFF_CHANNELS.commandComplete, { trigger: "continue" });
		await w.agentEnd(SESSION_FILE);
		await w.settle();
		assert.equal(w.sentMessages.length, 1, "the carried count nudges once the window closes");
	});

	it("H1 threshold: the settle nudge starts the count over", async () => {
		const h = buildDiaryHarness({ settleMinToolCalls: "default" }); // 3
		await h.sessionStart();

		// Run 1: exactly three calls → nudge.
		await h.toolStart("read");
		await h.toolStart("bash");
		await h.toolStart("edit");
		await h.agentEnd(SESSION_FILE);
		await h.settle();
		assert.equal(h.sentMessages.length, 1);
		assert.equal(h.state.toolCallsSinceDiary, 0, "the nudge send zeroed the count");

		// The nudge's own run makes a stray non-diary call and settles quiet
		// (D11); its calls are the diary turn and do not carry.
		await h.toolStart("read");
		await h.agentEnd(SESSION_FILE);
		await h.settle();
		assert.equal(h.state.toolCallsSinceDiary, 0, "the nudge run's settle zeroed the count");

		// Run 2: two more calls. A count carried over from before the nudge
		// would see 5 ≥ 3 and nudge again.
		await h.toolStart("read");
		await h.toolStart("bash");
		await h.agentEnd(SESSION_FILE);
		await h.settle();
		assert.equal(h.state.toolCallsSinceDiary, 2);
		assert.equal(h.sentMessages.length, 1, "nothing carries past the nudge");
	});

	it("H1 threshold: a diary write starts the count over", async () => {
		const h = buildDiaryHarness({ settleMinToolCalls: "default" }); // 3
		await h.sessionStart();

		// Two calls, then the diary write: the write zeroes the count and the
		// already-diarised settle stays quiet (D11).
		await h.toolStart("read");
		await h.toolStart("bash");
		await h.toolStart(DIARY_TOOL_NAME);
		assert.equal(h.state.toolCallsSinceDiary, 0, "the diary write zeroed the count");
		await h.toolStart("edit"); // work after the write counts again
		await h.agentEnd(SESSION_FILE);
		await h.settle();
		assert.equal(h.sentMessages.length, 0);
		assert.equal(h.state.toolCallsSinceDiary, 1, "only the post-write call carries");

		// Two more calls reach 3 accumulated since the write.
		await h.toolStart("read");
		await h.toolStart("bash");
		await h.agentEnd(SESSION_FILE);
		await h.settle();
		assert.equal(h.sentMessages.length, 1);
	});

	it("H1 threshold: a handoff nudge or a queued checkpoint starts the count over", async () => {
		// Handoff nudge: /handoff asks for the diary turn itself (D18, amended).
		const h = buildDiaryHarness({ settleMinToolCalls: "default" });
		await h.sessionStart();
		await h.toolStart("read");
		await h.toolStart("bash");
		await h.assistantMessage(); // warm cache for the /handoff cost gate (D22)
		h.emitBus(HANDOFF_CHANNELS.commandStart, {
			goal: null,
			quickMode: false,
			trigger: "handoff",
			timestamp: Date.now(),
			waitUntil: () => {},
		});
		assert.equal(h.sentMessages.length, 1, "the handoff nudge went out");
		assert.equal(h.state.toolCallsSinceDiary, 0, "the handoff nudge zeroed the count");

		// Checkpoint: the 15th exchange queues curation, whose prompt asks
		// for the diary write; its settle yields (D17) and zeroes the count.
		const c = buildDiaryHarness({ settleMinToolCalls: "default" });
		await c.sessionStart();
		for (let i = 0; i < 14; i++) await c.agentEnd(SESSION_FILE);
		await c.toolStart("read");
		await c.toolStart("bash");
		await c.toolStart("edit");
		await c.toolStart("write");
		await c.agentEnd(SESSION_FILE); // 15th → checkpoint queued
		await c.settle();
		assert.ok(
			c.sentMessages.every((m) => m.message.customType === "mempalace-autosave"),
			"the checkpoint settle yields the settle nudge",
		);
		assert.equal(c.state.toolCallsSinceDiary, 0, "the checkpoint settle zeroed the count");
	});
});
