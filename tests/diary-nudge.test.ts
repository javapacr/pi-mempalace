/**
 * Unit tests for the settle-nudge gate module (domain/diary-nudge.ts).
 *
 * Pure-function coverage without a fake pi: the diary-write suffix match
 * (isDiaryToolName), the active ∪ all registry search (hasDiaryTool), and
 * the settle gate as a truth table (shouldNudgeOnSettle) — an all-pass
 * baseline nudges, and every single flipped field gates the nudge off.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	HANDOFF_MAX_IDLE_LONG_MS,
	HANDOFF_MAX_IDLE_SHORT_MS,
	handoffCommandNudgeWorthwhile,
	resolveHandoffMaxIdleMs,
	type HandoffCommandNudgeInput,
	hasDiaryTool,
	isDiaryToolName,
	shouldNudgeOnSettle,
	type SettleNudgeInput,
} from "../domain/diary-nudge";

describe("diary nudge gate (unit)", () => {
	it("isDiaryToolName matches the diary-write suffix, never an exact name", () => {
		const matching = [
			"mempalace-personal_mempalace_diary_write",
			"mempalace-work_mempalace_diary_write",
			"mempalace_diary_write",
		];
		for (const name of matching) {
			assert.equal(isDiaryToolName(name), true, name);
		}

		const nearMisses = [
			"mempalace_diary_writer",
			"mempalace_diary_write_v2",
			"mempalace_recall",
			"mempalace_diary_writ",
		];
		for (const name of nearMisses) {
			assert.equal(isDiaryToolName(name), false, name);
		}
	});

	it("hasDiaryTool searches active and all registered tools", () => {
		assert.equal(
			hasDiaryTool(["unrelated_tool", "mempalace_diary_write"], []),
			true,
			"active-tools leg",
		);
		assert.equal(
			hasDiaryTool(["unrelated_tool"], [
				{ name: "mempalace-personal_mempalace_diary_write" },
			]),
			true,
			"all-tools leg",
		);
		assert.equal(
			hasDiaryTool(["mempalace_diary_writer"], [
				{ name: "mempalace_diary_write_v2" },
			]),
			false,
			"near-misses must not match",
		);
		assert.equal(hasDiaryTool([], []), false, "nothing registered");
	});

	it("shouldNudgeOnSettle: all-pass baseline nudges, each single flip gates it off", () => {
		const base: SettleNudgeInput = {
			aborted: false,
			mode: "tui",
			isChild: false,
			enabled: true,
			handoffInProgress: false,
			nudgeRun: false,
			diaryWrittenThisRun: false,
			// D18 baseline sits exactly at the threshold, so the added gate
			// stays in its nudging state here — the threshold's own behaviour
			// is pinned by the harness-level `H1 threshold:` tests.
			toolCallsSinceDiary: 3,
			minToolCalls: 3,
			checkpointQueued: false,
			diaryToolRegistered: true,
		};
		assert.equal(shouldNudgeOnSettle(base), true, "all-pass baseline nudges");

		const singleFlips: ReadonlyArray<
			readonly [field: string, flipped: SettleNudgeInput]
		> = [
			["aborted", { ...base, aborted: true }],
			["mode", { ...base, mode: "print" }],
			["isChild", { ...base, isChild: true }],
			["enabled", { ...base, enabled: false }],
			["handoffInProgress", { ...base, handoffInProgress: true }],
			["nudgeRun", { ...base, nudgeRun: true }],
			["diaryWrittenThisRun", { ...base, diaryWrittenThisRun: true }],
			["checkpointQueued", { ...base, checkpointQueued: true }],
			["diaryToolRegistered", { ...base, diaryToolRegistered: false }],
		];
		for (const [field, flipped] of singleFlips) {
			assert.equal(
				shouldNudgeOnSettle(flipped),
				false,
				`${field} flipped must gate the nudge off`,
			);
		}
	});
});

describe("/handoff cost gate (unit, D22)", () => {
	it("resolveHandoffMaxIdleMs: setting wins, else derived from PI_CACHE_RETENTION", () => {
		assert.equal(resolveHandoffMaxIdleMs(undefined, undefined), 270_000);
		assert.equal(resolveHandoffMaxIdleMs(undefined, "short"), HANDOFF_MAX_IDLE_SHORT_MS);
		assert.equal(resolveHandoffMaxIdleMs(undefined, "long"), 3_300_000);
		assert.equal(resolveHandoffMaxIdleMs(undefined, "long"), HANDOFF_MAX_IDLE_LONG_MS);
		assert.equal(resolveHandoffMaxIdleMs(60_000, "long"), 60_000);
	});

	const warm: HandoffCommandNudgeInput = {
		lastAssistantAt: 1_000_000,
		now: 1_000_000 + 270_000,
		maxIdleMs: 270_000,
		toolCallsSinceDiary: 1,
		checkpointPending: false,
	};

	it("warm cache with activity passes; exactly at the limit is still warm", () => {
		assert.equal(handoffCommandNudgeWorthwhile(warm), true);
	});

	it("cold cache or no assistant message yet fails", () => {
		assert.equal(handoffCommandNudgeWorthwhile({ ...warm, now: warm.now + 1 }), false);
		assert.equal(handoffCommandNudgeWorthwhile({ ...warm, lastAssistantAt: null }), false);
	});

	it("nothing to diarise fails unless a checkpoint is pending", () => {
		const idle = { ...warm, toolCallsSinceDiary: 0 };
		assert.equal(handoffCommandNudgeWorthwhile(idle), false);
		assert.equal(handoffCommandNudgeWorthwhile({ ...idle, checkpointPending: true }), true);
		// A pending checkpoint never overrides a cold cache.
		assert.equal(
			handoffCommandNudgeWorthwhile({ ...idle, checkpointPending: true, lastAssistantAt: null }),
			false,
		);
	});
});
