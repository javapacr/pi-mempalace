/**
 * Tests for the `request-attention` event listener.
 *
 * Covers:
 *  - parseRequestAttentionPayload: valid messages preserved exactly, extra
 *    fields tolerated, every malformed input falls back to the default
 *    without throwing.
 *  - Wiring: registerMempalaceEvents registers exactly one "request-attention"
 *    listener on pi.events; the notify capability captured at session_start
 *    (before the print-mode early return) receives the parsed message with
 *    "warning" severity; firing before any session_start is a safe no-op.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	DEFAULT_ATTENTION_MESSAGE,
	parseRequestAttentionPayload,
} from "../domain/attention";
import { registerMempalaceEvents } from "../infrastructure/event-registration";
import { SessionState } from "../domain/types";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { WakeUpUseCase } from "../application/wake-up.usecase";
import type { RecallUseCase } from "../application/recall.usecase";
import type { CurationUseCase } from "../application/curation.usecase";
import type { MiningUseCase } from "../application/mining.usecase";

// ── parseRequestAttentionPayload ─────────────────────────────────────────────

describe("parseRequestAttentionPayload", () => {
	it("preserves a valid payload message exactly", () => {
		assert.deepEqual(parseRequestAttentionPayload({ message: "X" }), {
			message: "X",
		});
	});

	it("tolerates extra fields on a valid payload", () => {
		assert.deepEqual(
			parseRequestAttentionPayload({
				message: "Sandbox permission required",
				source: "pi-claude-sandbox",
				extra: 42,
			}),
			{ message: "Sandbox permission required" },
		);
	});

	it("falls back to the default for null, undefined, and primitives", () => {
		for (const bad of [null, undefined, "msg", 42, true]) {
			assert.deepEqual(
				parseRequestAttentionPayload(bad),
				{ message: DEFAULT_ATTENTION_MESSAGE },
				`input=${String(bad)}`,
			);
		}
	});

	it("falls back to the default for missing/empty/non-string message", () => {
		for (const bad of [
			{},
			{ message: undefined },
			{ message: "" },
			{ message: null },
			{ message: 7 },
		]) {
			assert.deepEqual(
				parseRequestAttentionPayload(bad),
				{ message: DEFAULT_ATTENTION_MESSAGE },
				`input=${JSON.stringify(bad)}`,
			);
		}
	});

	it("always returns a { message: string } shape and never throws", () => {
		for (const input of [null, undefined, 0, false, "s", {}, { message: "ok" }]) {
			const result: { message: string } = parseRequestAttentionPayload(input);
			assert.equal(typeof result.message, "string");
			assert.ok(result.message.length > 0);
		}
	});
});

// ── Wiring: listener registration + captured-notify delivery ─────────────────

// Lifecycle handlers receive (event, ctx); bus listeners only ever get the
// payload, so ctx is optional.
type Handler = (event: unknown, ctx?: unknown) => Promise<unknown> | unknown;

function buildPi(listeners: Map<string, Handler[]>): ExtensionAPI {
	return {
		on: (name: string, cb: Handler) => {
			const list = listeners.get(name) ?? [];
			list.push(cb);
			listeners.set(name, list);
		},
		events: {
			on: (name: string, cb: Handler) => {
				const list = listeners.get(name) ?? [];
				list.push(cb);
				listeners.set(name, list);
			},
		},
		registerCommand: () => {},
		sendMessage: () => {},
	} as unknown as ExtensionAPI;
}

function buildStubs() {
	return {
		wakeUp: { execute: async () => "" } as unknown as WakeUpUseCase,
		recall: {
			execute: async () => ({ snippets: [], wing: null, palace: "" }),
		} as unknown as RecallUseCase,
		curation: {} as unknown as CurationUseCase,
		mining: {} as unknown as MiningUseCase,
		// Registration never touches the installer; members are no-ops so an
		// accidental call would surface as a call on a no-op, not a crash.
		skillInstaller: {
			readSkillDirState: () => null,
			installSkill: () => null,
			replaceSymlinkWithDir: () => null,
			replaceFileWithDir: () => null,
			updateSkill: () => null,
		} as never,
	};
}

describe("request-attention wiring", () => {
	it("registers the listener and notifies via the session_start capture", async () => {
		const listeners = new Map<string, Handler[]>();
		const state = new SessionState();
		const { wakeUp, recall, curation, mining, skillInstaller } = buildStubs();

		registerMempalaceEvents(
			buildPi(listeners),
			state,
			wakeUp,
			recall,
			curation,
			mining,
			skillInstaller,
		);

		const attention = listeners.get("request-attention") ?? [];
		assert.equal(
			attention.length,
			1,
			"one request-attention listener registered",
		);
		const fire = attention[0]!;

		// Capture the notify capability through session_start. Print mode keeps
		// the drive hermetic (no wake-up/skill-sync side effects) and pins the
		// capture-before-print-return contract at the same time.
		const notifyCalls: Array<{ message: string; type?: string }> = [];
		const sessionFile = join(scratch, "sessions", "s.jsonl");
		const sessionStart = (listeners.get("session_start") ?? [])[0];
		assert.ok(sessionStart, "session_start handler registered");
		await sessionStart(
			{},
			{
				mode: "print",
				cwd: scratch,
				sessionManager: { getSessionFile: () => sessionFile },
				ui: {
					notify: (message: string, type?: string) => {
						notifyCalls.push({ message, type });
					},
				},
			},
		);

		assert.equal(state.sessionFile, sessionFile, "session_start drove normally");

		fire({ message: "Sandbox permission required" });
		assert.deepEqual(notifyCalls, [
			{ message: "Sandbox permission required", type: "warning" },
		]);

		// Malformed payload still notifies, with the default message.
		fire(null);
		assert.deepEqual(notifyCalls[1], {
			message: DEFAULT_ATTENTION_MESSAGE,
			type: "warning",
		});
	});

	it("firing before any session_start (nothing captured) is a safe no-op", () => {
		const listeners = new Map<string, Handler[]>();
		const { wakeUp, recall, curation, mining, skillInstaller } = buildStubs();

		registerMempalaceEvents(
			buildPi(listeners),
			new SessionState(),
			wakeUp,
			recall,
			curation,
			mining,
			skillInstaller,
		);

		const attention = listeners.get("request-attention") ?? [];
		assert.equal(
			attention.length,
			1,
			"listener registered without session_start",
		);
		assert.doesNotThrow(() =>
			attention[0]!({ message: "Sandbox permission required" }),
		);
	});
});

// ── env/scratch hygiene ──────────────────────────────────────────────────────

let scratch = "";
let savedPalace: string | undefined;

beforeEach(async () => {
	scratch = await mkdtemp(join(tmpdir(), "attention-"));
	// Pin the palace leg so session_start's config resolution never reads
	// machine-specific defaults (settings/home-relative paths).
	savedPalace = process.env.MEMPALACE_PALACE;
	process.env.MEMPALACE_PALACE = join(scratch, "palace");
});

afterEach(async () => {
	if (savedPalace === undefined) delete process.env.MEMPALACE_PALACE;
	else process.env.MEMPALACE_PALACE = savedPalace;
	await rm(scratch, { recursive: true, force: true });
});
