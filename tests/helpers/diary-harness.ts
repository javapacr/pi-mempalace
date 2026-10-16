/**
 * Shared fake-pi harness for the diary-nudge stories (W1 settle, W2 handoff).
 *
 * Registers the real `registerMempalaceEvents` wiring against a recording
 * ExtensionAPI stub and exposes per-event drivers, so tests script whole
 * lifecycles (session → turns → settle) without a pi process. The bus is a
 * real EventEmitter: emitBus delivers synchronously, matching pi.events
 * semantics (W2's waitUntil test depends on it). Env redirections mirror
 * child-gate.test.ts's hermetic setup.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerMempalaceEvents } from "../../infrastructure/event-registration";
import { DEFAULT_MEMPALACE_SETTINGS, SessionState } from "../../domain/types";
import type { WakeUpUseCase } from "../../application/wake-up.usecase";
import type { RecallUseCase } from "../../application/recall.usecase";
import type { CurationUseCase } from "../../application/curation.usecase";
import type { MiningUseCase } from "../../application/mining.usecase";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

/** The diary-write tool as this profile registers it (suffix-matched, E8). */
export const DIARY_TOOL_NAME = "mempalace-personal_mempalace_diary_write";

const GATE_ENV_KEYS = [
	"PI_SUBAGENT_CHILD",
	"PI_SUBAGENT_CHILD_AGENT",
	"PI_MEMPALACE_CHILD_WAKEUP",
	"PI_MEMPALACE_CHILD_WAKEUP_AGENTS",
	"MEMPALACE_PALACE",
	"PI_CODING_AGENT_DIR",
] as const;

let savedEnv: Record<string, string | undefined> = {};
let scratchDir = "";

/**
 * Redirect every gate-relevant env var into a fresh scratch dir (palace +
 * agent dir), so child-gate evaluation and settings reads are hermetic.
 * Pair with restoreEnv() in afterEach.
 */
export async function setupHermeticEnv(): Promise<string> {
	scratchDir = await mkdtemp(join(tmpdir(), "diary-harness-"));
	await mkdir(join(scratchDir, "agent"), { recursive: true });
	savedEnv = {};
	for (const k of GATE_ENV_KEYS) {
		savedEnv[k] = process.env[k];
		delete process.env[k];
	}
	process.env.MEMPALACE_PALACE = join(scratchDir, "palace");
	process.env.PI_CODING_AGENT_DIR = join(scratchDir, "agent");
	return scratchDir;
}

/** Restore the env saved by setupHermeticEnv() and remove its scratch dir. */
export async function restoreEnv(): Promise<void> {
	for (const k of GATE_ENV_KEYS) {
		if (savedEnv[k] === undefined) delete process.env[k];
		else process.env[k] = savedEnv[k];
	}
	await rm(scratchDir, { recursive: true, force: true });
}

/** Write the project settings leg (<scratch>/.pi/settings.json — ctx.cwd). */
export async function writeProjectSettings(mempalace: unknown): Promise<void> {
	const path = join(scratchDir, ".pi", "settings.json");
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, JSON.stringify({ mempalace }));
}

export interface SentMessage {
	message: {
		customType?: string;
		content?: string;
		display?: boolean;
		details?: unknown;
	};
	options: { triggerTurn?: boolean; deliverAs?: string };
}

export interface DiaryHarness {
	readonly state: SessionState;
	readonly sentMessages: SentMessage[];
	/** Fire a shared-bus event; listeners run synchronously (EventEmitter).
	 *  Returns the LAST listener's return value, so tests can pin that a bus
	 *  listener stayed synchronous (returned undefined, never a Promise). */
	emitBus(channel: string, payload?: unknown): unknown;
	/** Each driver resolves with the last handler's return value, so tests
	 *  can pin what a handler gives back to pi (e.g. `input` must return
	 *  nothing — a returned value would transform or swallow the input). */
	sessionStart(mode?: string): Promise<unknown>;
	agentStart(): Promise<unknown>;
	agentEnd(sessionFile: string | null): Promise<unknown>;
	toolStart(toolName: string): Promise<unknown>;
	settle(opts?: {
		/** Value delivered on the event; pi ≥ 1.1 always sends a boolean
		 *  (default false). Non-boolean values pass through untyped on purpose,
		 *  so tests can probe the D10 structural guard. */
		aborted?: unknown;
		mode?: string;
		/** Deliver the pre-1.1 event shape: no aborted field at all (D10). */
		omitAborted?: boolean;
	}): Promise<unknown>;
	input(source: "interactive" | "rpc" | "extension"): Promise<unknown>;
	/** Tear the session down (W2): emits session_shutdown with the reason. */
	shutdown(reason: string): Promise<unknown>;
}

export interface DiaryHarnessOptions {
	/** getActiveTools() result; default: this profile's diary-write tool. */
	activeTools?: ReadonlyArray<string>;
	/** getAllTools() result; default: empty. */
	allTools?: ReadonlyArray<{ readonly name: string }>;
	/** Tool-getter availability: "missing" drops both getters (older pi,
	 *  minimal harnesses), "throw" makes both throw — hosts without a usable
	 *  registry must leave the diary nudges inert, never throw (D12/R3). */
	toolGetters?: "missing" | "throw";
	/** Mode used for every driver ctx; per-call overrides where offered. */
	mode?: string;
	/** Activity threshold forced into state.settings (D18) — after
	 *  construction AND after every sessionStart, since session_start
	 *  replaces the settings snapshot. Default 0, so the W1/W2 tests keep
	 *  exercising their own gates on tool-free runs; "default" leaves the
	 *  real settings value (3) in place for the W3 threshold tests. */
	settleMinToolCalls?: number | "default";
	/** ctx.ui.notify capture — the surface of the drift warning (D20). */
	notify?: (msg: string, level?: string) => void;
}

export function buildDiaryHarness(
	opts: DiaryHarnessOptions = {},
): DiaryHarness {
	const activeTools = opts.activeTools ?? [DIARY_TOOL_NAME];
	const allTools = opts.allTools ?? [];
	const defaultMode = opts.mode ?? "tui";

	const state = new SessionState();
	const handlers = new Map<string, Handler[]>();
	const bus = new EventEmitter();
	const sentMessages: SentMessage[] = [];

	const toolGetters: Record<string, () => unknown> =
		opts.toolGetters === "throw"
			? {
					getActiveTools: () => {
						throw new Error("tool registry unavailable");
					},
					getAllTools: () => {
						throw new Error("tool registry unavailable");
					},
				}
			: opts.toolGetters === "missing"
				? {}
				: { getActiveTools: () => activeTools, getAllTools: () => allTools };

	const pi = {
		on: (name: string, fn: Handler) => {
			const list = handlers.get(name) ?? [];
			list.push(fn);
			handlers.set(name, list);
		},
		events: {
			on: (channel: string, fn: (...args: unknown[]) => void) =>
				bus.on(channel, fn),
		},
		registerCommand: () => {},
		sendMessage: (
			message: SentMessage["message"],
			options: SentMessage["options"],
		) => {
			sentMessages.push({ message, options });
		},
		...toolGetters,
	} as unknown as ExtensionAPI;

	const wakeUp = {
		execute: async () => "WAKE-UP-CONTENT",
	} as unknown as WakeUpUseCase;
	const recall = {
		execute: async () => ({ snippets: [], wing: null, palace: "/tmp/palace" }),
	} as unknown as RecallUseCase;
	const curation = {
		buildPrompt: async () => ({ prompt: "x" }),
	} as unknown as CurationUseCase;
	const mining = {
		mineSync: async () => {},
		mineBackground: () => {},
	} as unknown as MiningUseCase;
	// Any touch is recorded as a failure — MANAGED_SKILLS is empty, so a
	// skill-sync call here would mean session_start drifted (child-gate parity).
	const skillInstaller = new Proxy(
		{},
		{
			get: (_t, prop) => {
				throw new Error(`unexpected skill-installer call: ${String(prop)}`);
			},
		},
	) as never;

registerMempalaceEvents(
		pi,
		state,
		wakeUp,
		recall,
		curation,
		mining,
		skillInstaller,
);

const notify = opts.notify ?? (() => {});

// Keep the forced threshold in place across the whole harness life: applied
// now (tests that never sessionStart) and re-applied after every
// sessionStart (session_start replaces state.settings from the files).
const forcedThreshold = opts.settleMinToolCalls ?? 0;
const forceSettleThreshold = (): void => {
	if (forcedThreshold === "default") return;
	state.settings = {
		...(state.settings ?? DEFAULT_MEMPALACE_SETTINGS),
		diarySettleMinToolCalls: forcedThreshold,
	};
};
forceSettleThreshold();

const ctxFor = (mode?: string, sessionFile: string | null = null) => ({
	mode: mode ?? defaultMode,
	cwd: scratchDir,
	sessionManager: { getSessionFile: () => sessionFile },
	ui: { notify },
});

	async function drive(name: string, event: unknown, ctx: unknown) {
		const fns = handlers.get(name) ?? [];
		assert.ok(fns.length > 0, `${name} handler registered`);
		let result: unknown;
		for (const fn of fns) result = await fn(event, ctx);
		return result;
	}

	return {
		state,
		sentMessages,
		emitBus: (channel, payload) => {
			// listeners() returns a snapshot copy — same order as emit, but the
			// per-listener return values stay observable (emit returns boolean).
			const listeners = bus.listeners(channel) as Array<
				(payload: unknown) => unknown
			>;
			let result: unknown;
			for (const listener of listeners) result = listener(payload);
			return result;
		},
		sessionStart: async (mode) => {
			const result = await drive("session_start", {}, ctxFor(mode));
			forceSettleThreshold();
			return result;
		},
		agentStart: () => drive("agent_start", { type: "agent_start" }, ctxFor()),
		agentEnd: (sessionFile) =>
			drive("agent_end", { type: "agent_end" }, ctxFor(undefined, sessionFile)),
		toolStart: (toolName) =>
			drive(
				"tool_execution_start",
				{ type: "tool_execution_start", toolCallId: "call-1", toolName, args: {} },
				ctxFor(),
			),
		settle: (settleOpts) => {
			const event: Record<string, unknown> = { type: "agent_settled" };
			// pi ≥ 1.1 delivers `aborted: false` on every settle; pre-1.1 hosts
			// omit the field entirely (D10) — omitAborted opts into that shape.
			if (!settleOpts?.omitAborted) {
				event.aborted = settleOpts?.aborted ?? false;
			}
			return drive("agent_settled", event, ctxFor(settleOpts?.mode));
		},
		input: (source) =>
			drive("input", { type: "input", text: "hello", source }, ctxFor()),
		shutdown: (reason) =>
			drive("session_shutdown", { type: "session_shutdown", reason }, ctxFor()),
	};
}
