/**
 * W2 — handoff diary nudge (H2) on both pi-handoff paths.
 *
 * Covers:
 *  - /handoff (`handoff_command_start{trigger:"handoff"}`): one hidden
 *    followUp nudge plus a `waitUntil` registration resolved on the next
 *    settle, aborted or not, and released on teardown (I2, D6/D14/D15)
 *  - the continue tool (`handoff_tool_start`): one hidden followUp nudge,
 *    deduped per session; no pending-nudge flag mid-stream (I3, D6/R8)
 *  - trigger/shape guards: bare /continue, missing or unknown trigger, and
 *    a missing waitUntil never nudge and never throw (D6/D14, R2)
 *  - gates: no diary tool, diary_on_handoff false, subagent child (I2/I3)
 *  - curation: the /handoff nudge's own run never advances
 *    conversationCount; the tool-path followUp run counts once (I5, D11/R8)
 *  - H1 interaction: the settle nudge stays quiet on the /handoff leg of the
 *    handoff-in-progress window, and only `trigger:"handoff"` quiets it (D8)
 */

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	buildDiaryHarness,
	restoreEnv,
	setupHermeticEnv,
	writeProjectSettings,
} from "./helpers/diary-harness";
import {
	HANDOFF_NUDGE_CUSTOM_TYPE,
	HANDOFF_NUDGE_TEXT,
	SETTLE_NUDGE_CUSTOM_TYPE,
} from "../domain/diary-nudge";
import { HANDOFF_CHANNELS } from "../domain/handoff-contract";

beforeEach(setupHermeticEnv);
afterEach(restoreEnv);

const SESSION_FILE = "/tmp/session.jsonl";

/** Let microtasks run so a resolver called inside a handler shows up. */
async function flush(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * Whether a registered wait resolved: releaseSettleWaiters calls its
 * resolvers synchronously inside the driver's already-awaited handler, so
 * one microtask flush is enough to observe the resolution. A false here
 * means the resolver never fired — the hang pi-handoff would sit through.
 */
async function resolvedAfterFlush(promise: Promise<unknown>): Promise<boolean> {
	let resolved = false;
	// Rejection counts as released too (pi-handoff tolerates both, E12); the
	// handlers below keep the observation itself rejection-safe.
	void promise.then(
		() => {
			resolved = true;
		},
		() => {
			resolved = true;
		},
	);
	await flush();
	return resolved;
}

/** A waitUntil spy: records the promises pi-mempalace registers. */
function waitCollector() {
	const promises: Promise<unknown>[] = [];
	return {
		promises,
		waitUntil(promise: Promise<unknown>): void {
			promises.push(promise);
		},
	};
}

/** A D6 `handoff_command_start` payload, emitted verbatim (E12: quickMode
 *  stays alongside trigger; waitUntil only where the test provides one). */
function commandStartPayload(
	trigger: unknown,
	waitUntil?: (promise: Promise<unknown>) => void,
): Record<string, unknown> {
	return {
		goal: null,
		quickMode: trigger === "continue",
		trigger,
		timestamp: 1,
		...(waitUntil ? { waitUntil } : {}),
	};
}

/** A D6 `handoff_tool_start` payload, emitted verbatim. */
function toolStartPayload(): Record<string, unknown> {
	return { goal: "Ship it", command: "/continue", timestamp: 1 };
}

describe("handoff nudge (W2)", () => {
	it("H2 /handoff registers waitUntil synchronously and sends one hidden followUp nudge", () => {
		const h = buildDiaryHarness();

		const collector = waitCollector();
		const listenerResult = h.emitBus(
			HANDOFF_CHANNELS.commandStart,
			commandStartPayload("handoff", collector.waitUntil),
		);

		// Synchronous registration: called before the emit returned (Gotcha)…
		assert.equal(collector.promises.length, 1);
		assert.ok(collector.promises[0] instanceof Promise);
		// …and the listener itself returned undefined, not a Promise.
		assert.equal(listenerResult, undefined);

		// Exactly one hidden followUp nudge (D7/D16).
		assert.equal(h.sentMessages.length, 1);
		assert.deepEqual(h.sentMessages[0].message, {
			customType: HANDOFF_NUDGE_CUSTOM_TYPE,
			content: HANDOFF_NUDGE_TEXT,
			display: false,
		});
		assert.deepEqual(h.sentMessages[0].options, {
			triggerTurn: true,
			deliverAs: "followUp",
		});
		// The agent is idle at /handoff, so the nudge starts its own run (D13).
		assert.ok(
			h.state.nudgeRunPending,
			"an idle /handoff nudge owns its run (D13)",
		);
	});

	it("H2 /handoff wait resolves on the next settle, aborted or not", async () => {
		const h = buildDiaryHarness();
		await h.sessionStart();

		// Aborted settle still releases the wait (D15).
		const abortedCollector = waitCollector();
		h.emitBus(
			HANDOFF_CHANNELS.commandStart,
			commandStartPayload("handoff", abortedCollector.waitUntil),
		);
		await h.settle({ aborted: true });
		assert.equal(abortedCollector.promises.length, 1);
		assert.ok(
			await resolvedAfterFlush(abortedCollector.promises[0]),
			"an aborted settle resolves the wait (D15)",
		);
		assert.equal(
			h.state.settleWaiters.length,
			0,
			"releaseSettleWaiters splices — no resolver survives a settle",
		);

		// So does a normal one.
		const cleanCollector = waitCollector();
		h.emitBus(
			HANDOFF_CHANNELS.commandStart,
			commandStartPayload("handoff", cleanCollector.waitUntil),
		);
		await h.settle();
		assert.ok(
			await resolvedAfterFlush(cleanCollector.promises[0]),
			"a normal settle resolves the wait",
		);
		assert.equal(h.state.settleWaiters.length, 0);
	});

	it("H2 /handoff wait is released on session_shutdown and session_start", async () => {
		const h = buildDiaryHarness();
		await h.sessionStart();

		// session_shutdown releases before its reload early return (D15).
		const shutdownCollector = waitCollector();
		h.emitBus(
			HANDOFF_CHANNELS.commandStart,
			commandStartPayload("handoff", shutdownCollector.waitUntil),
		);
		await h.shutdown("reload");
		assert.ok(
			await resolvedAfterFlush(shutdownCollector.promises[0]),
			"shutdown releases the wait even for a reload (D15)",
		);

		// session_start releases BEFORE state.reset() (Gotcha: reset would
		// drop the resolvers and pi-handoff would sit out its full 120s).
		const restartCollector = waitCollector();
		h.emitBus(
			HANDOFF_CHANNELS.commandStart,
			commandStartPayload("handoff", restartCollector.waitUntil),
		);
		await h.sessionStart();
		assert.ok(
			await resolvedAfterFlush(restartCollector.promises[0]),
			"session_start releases the wait before reset (D15)",
		);
	});

	it("H2 /handoff without waitUntil sends no nudge", async () => {
		const h = buildDiaryHarness();
		await h.sessionStart();
		await h.agentEnd(SESSION_FILE); // arm H1

		h.emitBus(
			HANDOFF_CHANNELS.commandStart,
			commandStartPayload("handoff"), // D14: contract drift — no waitUntil
		);

		assert.equal(h.sentMessages.length, 0, "no handoff nudge without a wait");

		// D14 keeps the handoff-in-progress flag raised: the settle stays quiet…
		await h.settle();
		assert.equal(h.sentMessages.length, 0);
		// …and only because of the flag — the next interactive input reopens H1.
		await h.input("interactive");
		await h.settle();
		assert.equal(h.sentMessages.length, 1);
		assert.equal(h.sentMessages[0].message.customType, SETTLE_NUDGE_CUSTOM_TYPE);
	});

	it("H2 ignores trigger continue, missing or unknown trigger without throwing", () => {
		const h = buildDiaryHarness();

		const continueCollector = waitCollector();
		const payloads: unknown[] = [
			commandStartPayload("continue", continueCollector.waitUntil), // bare /continue
			commandStartPayload(undefined), // today's installed pi-handoff: no trigger at all
			commandStartPayload("deploy"), // unknown trigger
			42, // not even an object
			null,
		];
		for (const payload of payloads) {
			h.emitBus(HANDOFF_CHANNELS.commandStart, payload); // must not throw
		}

		assert.equal(
			continueCollector.promises.length,
			0,
			"a continue trigger never registers a wait",
		);
		assert.equal(h.sentMessages.length, 0);
		assert.equal(
			h.state.handoffInProgress,
			false,
			"only trigger:handoff raises the window (D8)",
		);
	});

	it("H2 contract: waitUntil is invoked as a method on the payload", () => {
		const h = buildDiaryHarness();
		// pi-handoff's collector reads `this` (Gotcha): a detached
		// `const fn = payload.waitUntil; fn(p)` would lose it and throw inside
		// the listener — the nudge would be lost with it.
		const payload = {
			goal: null,
			quickMode: false,
			trigger: "handoff",
			timestamp: 1,
			seen: 0,
			waitUntil(this: { seen: number }, _promise: Promise<unknown>): void {
				this.seen++;
			},
		};
		h.emitBus(HANDOFF_CHANNELS.commandStart, payload);

		assert.equal(
			payload.seen,
			1,
			"called as payload.waitUntil(p), so this is the payload",
		);
		assert.equal(h.sentMessages.length, 1, "the nudge path ran without a throw");
	});

	it("H2 tool: handoff_tool_start sends one hidden followUp nudge", async () => {
		const h = buildDiaryHarness();
		await h.sessionStart();
		// The continue tool fires inside a streaming run (Gotcha): stage it.
		await h.agentStart();

		h.emitBus(HANDOFF_CHANNELS.toolStart, toolStartPayload());

		assert.equal(h.sentMessages.length, 1);
		assert.deepEqual(h.sentMessages[0].message, {
			customType: HANDOFF_NUDGE_CUSTOM_TYPE,
			content: HANDOFF_NUDGE_TEXT,
			display: false,
		});
		assert.deepEqual(h.sentMessages[0].options, {
			triggerTurn: true,
			deliverAs: "followUp",
		});
		// Mid-stream the nudge is a followUp inside the running run — it must
		// NOT claim the pending-nudge flag (R8): that run counts once, as usual.
		assert.equal(h.state.nudgeRunPending, false);
	});

	it("H2 tool: repeated handoff_tool_start sends nothing more", async () => {
		const h = buildDiaryHarness();
		await h.sessionStart();
		await h.agentStart();

		h.emitBus(HANDOFF_CHANNELS.toolStart, toolStartPayload());
		h.emitBus(HANDOFF_CHANNELS.toolStart, toolStartPayload());

		assert.equal(h.sentMessages.length, 1, "deduped per session (D6)");

		// The dedupe survives the run's own settle.
		await h.settle();
		assert.equal(h.sentMessages.length, 1);
	});

	it("H2 nudge text forbids a second continue and asks for a one-line skip", () => {
		// D16 verbatim.
		assert.equal(
			HANDOFF_NUDGE_TEXT,
			"[MemPalace handoff diary] A handoff is about to snapshot this session. If the session produced anything durable that is not yet in your MemPalace diary, write one diary entry now with the diary-write tool. If nothing is durable, or a diary entry already exists, reply with one short line and stop. Start no new work, and do not call `continue` again — the handoff is already under way.",
		);
		// The three pinned properties, spelled out (R4/E10): a second `continue`
		// would become the newest document and win recovery.
		assert.match(HANDOFF_NUDGE_TEXT, /do not call `continue` again/);
		assert.match(HANDOFF_NUDGE_TEXT, /reply with one short line and stop/);
		assert.match(HANDOFF_NUDGE_TEXT, /Start no new work/);
	});

	it("H2 gates: no diary tool registered", async () => {
		const h = buildDiaryHarness({
			activeTools: [],
			allTools: [{ name: "mempalace-personal_mempalace_recall" }],
		});
		await h.sessionStart();

		const collector = waitCollector();
		h.emitBus(
			HANDOFF_CHANNELS.commandStart,
			commandStartPayload("handoff", collector.waitUntil),
		);
		await h.agentStart();
		h.emitBus(HANDOFF_CHANNELS.toolStart, toolStartPayload());

		assert.equal(h.sentMessages.length, 0);
		assert.equal(
			collector.promises.length,
			0,
			"no nudge → nothing for pi-handoff to wait for",
		);
	});

	it("H2 gates: diary_on_handoff false", async () => {
		await writeProjectSettings({ diary_on_handoff: false });
		const h = buildDiaryHarness();
		await h.sessionStart();

		const collector = waitCollector();
		h.emitBus(
			HANDOFF_CHANNELS.commandStart,
			commandStartPayload("handoff", collector.waitUntil),
		);
		await h.agentStart();
		h.emitBus(HANDOFF_CHANNELS.toolStart, toolStartPayload());

		assert.equal(h.sentMessages.length, 0);
		assert.equal(collector.promises.length, 0);
	});

	it("H2 gates: subagent child", async () => {
		const h = buildDiaryHarness();
		await h.sessionStart();
		// Per-event gate: the child env arrives only at the bus events (PRD A3).
		process.env.PI_SUBAGENT_CHILD = "1";

		const collector = waitCollector();
		h.emitBus(
			HANDOFF_CHANNELS.commandStart,
			commandStartPayload("handoff", collector.waitUntil),
		);
		await h.agentStart();
		h.emitBus(HANDOFF_CHANNELS.toolStart, toolStartPayload());

		assert.equal(h.sentMessages.length, 0);
		assert.equal(collector.promises.length, 0);
	});

	it("H2 curation: handoff diary run does not advance conversationCount", async () => {
		const h = buildDiaryHarness();
		await h.sessionStart();
		// 14 real exchanges: one more would hit the save_interval checkpoint.
		for (let i = 0; i < 14; i++) await h.agentEnd(SESSION_FILE);

		// /handoff nudge → its own run…
		h.emitBus(
			HANDOFF_CHANNELS.commandStart,
			commandStartPayload("handoff", waitCollector().waitUntil),
		);
		assert.ok(h.state.nudgeRunPending);
		// …whose agent_end must skip the increment AND the checkpoint check —
		// without the D11 guard it would reach 15 and re-send curation.
		await h.agentEnd(SESSION_FILE);
		await h.settle(); // consumes the pending flag

		assert.equal(h.state.conversationCount, 14, "the diary run never counts");
		assert.equal(
			h.sentMessages.filter((m) => m.message.customType === "mempalace-autosave")
				.length,
			0,
			"no curation checkpoint either",
		);
		assert.equal(h.sentMessages.length, 1, "only the handoff nudge");
	});

	it("H2 curation: tool-path run counts once", async () => {
		const h = buildDiaryHarness();
		await h.sessionStart();
		for (let i = 0; i < 3; i++) await h.agentEnd(SESSION_FILE); // count 3

		// The continue tool fires mid-run: nudge as followUp, no pending flag…
		await h.agentStart();
		h.emitBus(HANDOFF_CHANNELS.toolStart, toolStartPayload());
		assert.equal(h.state.nudgeRunPending, false);
		// …so the combined run's agent_end counts exactly once (R8).
		await h.agentEnd(SESSION_FILE);
		await h.settle();

		assert.equal(h.state.conversationCount, 4, "counted once, as usual");
		assert.equal(h.sentMessages.length, 1, "the handoff nudge; H1 stays quiet");
	});

	it("H2 run tracking: agent_settled clears agentRunActive", async () => {
		await writeProjectSettings({ diary_on_settle: false }); // isolate from H1
		const h = buildDiaryHarness();
		await h.sessionStart();
		await h.agentStart();
		await h.agentEnd(SESSION_FILE); // count 1
		await h.settle(); // D13: this settle must clear agentRunActive

		// Idle at /handoff → the nudge starts a run of its own (D13)…
		const collector = waitCollector();
		h.emitBus(
			HANDOFF_CHANNELS.commandStart,
			commandStartPayload("handoff", collector.waitUntil),
		);
		assert.ok(
			h.state.nudgeRunPending,
			"the nudge owns its run only because agentRunActive was cleared",
		);

		// …so that run's agent_end must not advance the count (D11): it stays
		// at the first run's count.
		await h.agentEnd(SESSION_FILE);
		await h.settle();
		assert.equal(h.state.conversationCount, 1, "the diary run never counts");
	});

	it("H2 run tracking: a fresh session re-arms the tool-path dedupe", async () => {
		const h = buildDiaryHarness();
		await h.sessionStart();
		await h.agentStart();
		h.emitBus(HANDOFF_CHANNELS.toolStart, toolStartPayload());
		await h.settle();

		// session_start's reset() clears handoffToolNudged — the dedupe is per
		// session, not per process (D6/R9).
		await h.sessionStart();
		await h.agentStart();
		h.emitBus(HANDOFF_CHANNELS.toolStart, toolStartPayload());

		assert.equal(
			h.sentMessages.filter(
				(m) => m.message.customType === HANDOFF_NUDGE_CUSTOM_TYPE,
			).length,
			2,
			"exactly one nudge per session",
		);
	});

	it("H2 run tracking: a mid-stream /handoff does not claim its own run", async () => {
		const h = buildDiaryHarness();
		await h.sessionStart();
		// Extension commands can run mid-stream (E15): stage a run first.
		await h.agentStart();

		const collector = waitCollector();
		h.emitBus(
			HANDOFF_CHANNELS.commandStart,
			commandStartPayload("handoff", collector.waitUntil),
		);

		// The nudge is a followUp inside the running run (R8/D13)…
		assert.equal(h.state.nudgeRunPending, false);
		assert.equal(collector.promises.length, 1, "the wait still registers");
		assert.equal(h.sentMessages.length, 1, "…and the nudge still fires");
	});

	it("H1 quiet during handoff: handoff_command_start trigger handoff", async () => {
		const h = buildDiaryHarness();
		await h.sessionStart();
		await h.agentEnd(SESSION_FILE); // arm H1

		h.emitBus(
			HANDOFF_CHANNELS.commandStart,
			commandStartPayload("handoff", waitCollector().waitUntil),
		);

		// The /handoff nudge (H2) fires; the settle nudge (H1) must not.
		await h.settle();
		assert.equal(
			h.sentMessages.filter((m) => m.message.customType === SETTLE_NUDGE_CUSTOM_TYPE)
				.length,
			0,
			"H1 stays quiet on the /handoff leg (D8)",
		);

		// …until handoff_command_complete closes the window.
		h.emitBus(HANDOFF_CHANNELS.commandComplete, commandStartPayload("handoff"));
		await h.settle();
		assert.ok(
			h.sentMessages.some(
				(m) => m.message.customType === SETTLE_NUDGE_CUSTOM_TYPE,
			),
			"H1 resumes after handoff_command_complete",
		);

		// The interactive-input leg closes the window too — verified on a
		// fresh harness so the earlier complete cannot mask it.
		const h2 = buildDiaryHarness();
		await h2.sessionStart();
		await h2.agentEnd(SESSION_FILE);
		h2.emitBus(
			HANDOFF_CHANNELS.commandStart,
			commandStartPayload("handoff", waitCollector().waitUntil),
		);
		await h2.settle();
		assert.equal(
			h2.sentMessages.filter((m) => m.message.customType === SETTLE_NUDGE_CUSTOM_TYPE)
				.length,
			0,
		);
		await h2.input("interactive");
		await h2.settle();
		assert.ok(
			h2.sentMessages.some(
				(m) => m.message.customType === SETTLE_NUDGE_CUSTOM_TYPE,
			),
			"H1 resumes after the next interactive input",
		);
	});

	it("H1 not quieted by trigger continue", async () => {
		const h = buildDiaryHarness();
		await h.sessionStart();
		await h.agentEnd(SESSION_FILE);

		// A bare /continue must not raise the window (D8): H1 nudges as usual.
		h.emitBus(
			HANDOFF_CHANNELS.commandStart,
			commandStartPayload("continue"),
		);
		await h.settle();

		assert.equal(h.sentMessages.length, 1);
		assert.equal(h.sentMessages[0].message.customType, SETTLE_NUDGE_CUSTOM_TYPE);
	});
});
