/**
 * Repo-wing awareness of the curation checkpoint prompt (BRD P2 §11 sibling).
 *
 * The old prompt hardcoded `Target wing: sessions`, steering diary writes away
 * from repo wings. "sessions" is the mined-transcript archive, never a diary
 * home; repo-anchored work files under the repo's wing, personal/cross-repo
 * items under the agent wing.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildCurationPrompt } from "../domain/curation-prompt";
import type { MempalaceConfig } from "../domain/types";

function cfg(wing: string | null): MempalaceConfig {
	return { palace: "/tmp/palace", wing, rooms: [] };
}

describe("repo-wing aware checkpoint prompt", () => {
	it("steers to repo wings instead of sessions", () => {
		const prompt = buildCurationPrompt(cfg("sessions"), 30);
		assert.match(
			prompt,
			/Target wing: if this session's work is anchored in a long-lived repo/,
		);
		assert.match(prompt, /The sessions wing is for mined transcripts, not diaries/);
	});

	it("never presents sessions as the diary target", () => {
		for (const wing of ["sessions", null]) {
			const prompt = buildCurationPrompt(cfg(wing), 30);
			assert.doesNotMatch(prompt, /Target wing: sessions/);
		}
	});

	it("interpolates the caller-resolved repo hint only when provided", () => {
		const withHint = buildCurationPrompt(cfg(null), 30, "pi-mempalace");
		assert.match(withHint, /Likely repo wing: pi-mempalace/);
		const withoutHint = buildCurationPrompt(cfg(null), 30);
		assert.doesNotMatch(withoutHint, /Likely repo wing:/);
	});

	it("personal/cross-repo items go to the agent wing", () => {
		const named = buildCurationPrompt(cfg("alice"), 30);
		assert.match(named, /your agent wing \(e\.g\. alice\)/);
		const unnamed = buildCurationPrompt(cfg(null), 30);
		assert.match(unnamed, /your agent wing\./);
	});

	it("original checkpoint contract still holds", () => {
		const prompt = buildCurationPrompt(cfg("sessions"), 30);
		assert.match(prompt, /\[MemPalace checkpoint — 30 exchanges\]/);
		assert.match(prompt, /Curate this session yourself/);
		assert.match(prompt, /do NOT dispatch a subagent/);
		assert.match(prompt, /CURATION COMPLETE/);
		assert.match(prompt, /\/tmp\/palace/);
		assert.doesNotMatch(prompt, /subagent\(/);
	});
});
