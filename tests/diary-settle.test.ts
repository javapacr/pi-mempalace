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

		await h.settle();

		assert.equal(h.sentMessages.length, 0);
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
		const viaActive = buildDiaryHarness({
			activeTools: ["unrelated_tool", DIARY_TOOL_NAME],
		});
		await viaActive.sessionStart();
		await viaActive.agentEnd(SESSION_FILE);
		await viaActive.settle();
		assert.equal(viaActive.sentMessages.length, 1, "active-tools leg");

		const viaAll = buildDiaryHarness({
			activeTools: ["unrelated_tool"],
			allTools: [{ name: DIARY_TOOL_NAME }],
		});
		await viaAll.sessionStart();
		await viaAll.agentEnd(SESSION_FILE);
		await viaAll.settle();
		assert.equal(viaAll.sentMessages.length, 1, "all-tools leg");
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

		await h.input("rpc"); // non-interactive input must NOT close the window
		await h.settle();
		assert.equal(h.sentMessages.length, 0);

		await h.input("interactive");
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
		assert.ok(h.state.nudgeRunPending);
		assert.ok(h.state.handoffInProgress);

		await h.sessionStart();

		assert.equal(h.state.nudgeRunPending, false);
		assert.equal(h.state.handoffInProgress, false);
		// Both flags cleared: a stale pending flag would read this settle as
		// a nudge run, a stale handoff flag would suppress it — either way
		// the count would stay at 1 instead of 2.
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
