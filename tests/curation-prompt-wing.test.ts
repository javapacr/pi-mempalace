/**
 * Wing contract of the curation checkpoint prompt.
 *
 * The extension ships wing MECHANISM only: the caller-resolved `Likely repo
 * wing: X` hint is interpolated, and no wing-routing policy sentences are
 * embedded (2026-09-01 genericity strip — pi extensions must be generic;
 * wing-routing policy is owned by MemPalace core tool descriptions and
 * user-side config/docs).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildCurationPrompt } from "../domain/curation-prompt";
import type { MempalaceConfig } from "../domain/types";

function cfg(wing: string | null): MempalaceConfig {
	return { palace: "/tmp/palace", wing, rooms: [] };
}

describe("wing-mechanism-only checkpoint prompt", () => {
	it("interpolates the caller-resolved repo hint only when provided", () => {
		const withHint = buildCurationPrompt(cfg(null), 30, "pi-mempalace");
		assert.match(withHint, /Likely repo wing: pi-mempalace/);
		const withoutHint = buildCurationPrompt(cfg(null), 30);
		assert.doesNotMatch(withoutHint, /Likely repo wing:/);
	});

	it("embeds no wing-routing policy regardless of wing or hint", () => {
		for (const wing of ["sessions", "alice", null]) {
			for (const hint of [undefined, "some-repo"]) {
				const prompt = buildCurationPrompt(cfg(wing), 30, hint);
				assert.doesNotMatch(prompt, /Target wing:/);
				assert.doesNotMatch(prompt, /agent wing/);
				assert.doesNotMatch(prompt, /sessions wing/);
				assert.doesNotMatch(prompt, /Personal or cross-repo/);
				assert.doesNotMatch(prompt, /pi-mempalace-github/);
			}
		}
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
