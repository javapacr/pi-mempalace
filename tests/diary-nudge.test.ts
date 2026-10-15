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
