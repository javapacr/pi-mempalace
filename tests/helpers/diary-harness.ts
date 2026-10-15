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
import { SessionState } from "../../domain/types";
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
	/** Fire a shared-bus event; listeners run synchronously (EventEmitter). */
	emitBus(channel: string, payload?: unknown): void;
	sessionStart(mode?: string): Promise<void>;
	agentStart(): Promise<void>;
	agentEnd(sessionFile: string | null): Promise<void>;
	toolStart(toolName: string): Promise<void>;
	settle(opts?: { aborted?: boolean; mode?: string }): Promise<void>;
	input(source: "interactive" | "rpc" | "extension"): Promise<void>;
}

export interface DiaryHarnessOptions {
	/** getActiveTools() result; default: this profile's diary-write tool. */
	activeTools?: ReadonlyArray<string>;
	/** getAllTools() result; default: empty. */
	allTools?: ReadonlyArray<{ readonly name: string }>;
	/** Mode used for every driver ctx; per-call overrides where offered. */
	mode?: string;
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
		getActiveTools: () => activeTools,
		getAllTools: () => allTools,
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

	const ctxFor = (mode?: string, sessionFile: string | null = null) => ({
		mode: mode ?? defaultMode,
		cwd: scratchDir,
		sessionManager: { getSessionFile: () => sessionFile },
		ui: { notify: () => {} },
	});

	async function drive(name: string, event: unknown, ctx: unknown) {
		const fns = handlers.get(name) ?? [];
		assert.ok(fns.length > 0, `${name} handler registered`);
		for (const fn of fns) await fn(event, ctx);
	}

	return {
		state,
		sentMessages,
		emitBus: (channel, payload) => bus.emit(channel, payload),
		sessionStart: (mode) =>
			drive("session_start", {}, ctxFor(mode)),
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
			if (settleOpts?.aborted !== undefined) event.aborted = settleOpts.aborted;
			return drive("agent_settled", event, ctxFor(settleOpts?.mode));
		},
		input: (source) =>
			drive("input", { type: "input", text: "hello", source }, ctxFor()),
	};
}
