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
		h.emitBus(HANDOFF_CHANNELS.toolStart, {
			goal: "x",
			command: "/continue",
		});

		await h.settle();

		assert.equal(h.sentMessages.length, 0);
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
		h.emitBus(HANDOFF_CHANNELS.toolStart, {});
		h.emitBus(HANDOFF_CHANNELS.commandComplete, { trigger: "continue" });

		await h.settle();

		assert.equal(h.sentMessages.length, 1);
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
		h.emitBus(HANDOFF_CHANNELS.toolStart, {}); // handoff window raised
		await h.toolStart(DIARY_TOOL_NAME); // already-diarised mark
		assert.ok(h.state.nudgeRunPending);
		assert.ok(h.state.handoffInProgress);
		assert.ok(h.state.diaryWrittenThisRun);

		await h.sessionStart();

		assert.equal(h.state.nudgeRunPending, false);
		assert.equal(h.state.handoffInProgress, false);
		assert.equal(
			h.state.diaryWrittenThisRun,
			false,
			"the per-run diary mark resets too (D11)",
		);
		// All three flags cleared: a stale pending flag would read this settle as
		// a nudge run, a stale handoff flag or a stale diary mark would suppress
		// it — either way the count would stay at 1 instead of 2.
		await h.settle();
		assert.equal(h.sentMessages.length, 2);
	});

	it("curation still fires every save_interval real exchanges with nudges interleaved", async () => {
		const h = buildDiaryHarness();
		await h.sessionStart();

		for (let i = 0; i < 15; i++) {
			await h.agentEnd(SESSION_FILE); // real exchange
			await h.settle(); // nudge fires, pending flag set
			await h.agentEnd(SESSION_FILE); // the nudge's run
			await h.settle(); // nudge run settles quietly
		}

		assert.equal(h.state.conversationCount, 15, "only real exchanges count");
		const checkpoints = h.sentMessages.filter(
			(m) => m.message.customType === "mempalace-autosave",
		);
		assert.equal(checkpoints.length, 1, "checkpoint exactly at the 15th");
		assert.equal(checkpoints[0].options.deliverAs, "nextTurn");
		const nudges = h.sentMessages.filter(
			(m) => m.message.customType === SETTLE_NUDGE_CUSTOM_TYPE,
		);
		assert.equal(nudges.length, 15, "one nudge per real exchange");
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
});
