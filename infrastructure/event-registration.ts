/**
 * Event registration — binds MemPalace lifecycle hooks to the pi ExtensionAPI.
 *
 * All pi.on() calls live here. Each handler is thin: it delegates to the
 * appropriate use case and maps the result back to pi's return shape.
 */

import type {
	ExtensionAPI,
	ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MEMPALACE_SETTINGS,
	RECALL_CUSTOM_TYPE,
	type SessionState,
} from "../domain/types";
import { resolveMempalaceConfig } from "../domain/palace-router";
import {
	childFeatureGates,
	resolveChildWakeupGate,
} from "../domain/child-gate";
import { parseRequestAttentionPayload } from "../domain/attention";
import {
	isDiaryToolName,
	hasDiaryTool,
	shouldNudgeOnSettle,
	handoffNudgeAllowed,
	SETTLE_NUDGE_CUSTOM_TYPE,
	SETTLE_NUDGE_TEXT,
	HANDOFF_NUDGE_CUSTOM_TYPE,
	HANDOFF_NUDGE_TEXT,
	HANDOFF_CHECKPOINT_NUDGE_TEXT,
} from "../domain/diary-nudge";
import {
	HANDOFF_CHANNELS,
	HANDOFF_DRIFT_WARNING,
	HANDOFF_WAIT_SELF_BOUND_MS,
	parseHandoffCommandStart,
} from "../domain/handoff-contract";
import { formatRecallContext } from "../domain/recall-parser";
import type { WakeUpUseCase } from "../application/wake-up.usecase";
import type { RecallUseCase } from "../application/recall.usecase";
import type { CurationUseCase } from "../application/curation.usecase";
import type { MiningUseCase } from "../application/mining.usecase";
import type { SkillSyncReport } from "../application/skill-sync.usecase";
import { syncSkills } from "../application/skill-sync.usecase";
import { readMempalaceSettings } from "./settings-reader";
// import { ensureMcp } from "../application/mcp-ownership.usecase"; // MCP registration is manual — static mcp.json owns it (2026-09-01)
import type {
	readSkillDirState,
	installSkill,
	replaceSymlinkWithDir,
	replaceFileWithDir,
	updateSkill,
} from "../infrastructure/skill-installer";

// ── Child-gate observability (PRD §4 A3/A6) ─────────────────────────────────
// One line each per session (flags live on SessionState) — children are
// short-lived processes; the logs make a broken PI_SUBAGENT_CHILD upstream
// contract (or a stray hatch) visible instead of silent.
function logGateSkipOnce(state: SessionState, reason: string): void {
	if (state.gateSkipLogged) return;
	state.gateSkipLogged = true;
	console.error(
		`MemPalace: child gate active — wake-up, skill sync, and MCP ensure skipped for subagent child (PI_SUBAGENT_CHILD=1, reason: ${reason})`,
	);
}

function logHatchOnce(state: SessionState, reason: string): void {
	if (state.hatchLogged) return;
	state.hatchLogged = true;
	console.error(
		`MemPalace: child wake-up hatch active (PI_MEMPALACE_CHILD_WAKEUP=1, reason: ${reason}) — wake-up NOT gated for this child`,
	);
}

// pi < 0.86 has no structured prompt sections — wake-up injection is skipped
// there (user decision D2: no forced-systemPrompt fallback). One line per session.
function logNoSectionsOnce(state: SessionState): void {
	if (state.noSectionsLogged) return;
	state.noSectionsLogged = true;
	console.error(
		"MemPalace: host pi has no systemPromptOptions.sections (pi < 0.86) — wake-up context not injected; recall unaffected",
	);
}

/** Prompt section name for the wake-up context; pi renders it as `<mempalace>…</mempalace>`. */
export const WAKEUP_SECTION = "mempalace";

/**
 * Diary-write tool lookup across active ∪ all registered tools. Wrapped in
 * try/catch → false: hosts without the tool getters (older pi, minimal
 * harnesses) leave the diary nudges inert instead of throwing from a hook
 * (D12, R3).
 */
function diaryToolRegistered(pi: ExtensionAPI): boolean {
	try {
		return hasDiaryTool(pi.getActiveTools(), pi.getAllTools());
	} catch {
		return false;
	}
}

/**
 * Release the promises registered with pi-handoff's `/handoff` waitUntil
 * (D15): splices the array and calls each resolver in its own try/catch, so
 * one bad resolver cannot skip the rest. Resolve-only — pi-handoff tolerates
 * rejections (E12), but resolving keeps the contract trivial.
 */
function releaseSettleWaiters(state: SessionState): void {
	// D19: disarm the self-bound first — every release path (settle, teardown,
	// the bound itself) must leave no timer behind for a quitting pi to wait
	// out, and the next registered batch must arm a fresh one.
	if (state.settleWaiterTimer !== null) {
		clearTimeout(state.settleWaiterTimer);
		state.settleWaiterTimer = null;
	}
	const waiters = state.settleWaiters.splice(0);
	for (const resolve of waiters) {
		try {
			resolve();
		} catch {
			// Never throw from a hook — pi-handoff owns the 120s deadline and
			// attaches its own no-op rejection handler (E11/E12).
		}
	}
}

export function registerMempalaceEvents(
	pi: ExtensionAPI,
	state: SessionState,
	wakeUp: WakeUpUseCase,
	recall: RecallUseCase,
	curation: CurationUseCase,
	mining: MiningUseCase,
	skillInstaller: {
		readonly readSkillDirState: typeof readSkillDirState;
		readonly installSkill: typeof installSkill;
		readonly replaceSymlinkWithDir: typeof replaceSymlinkWithDir;
		readonly replaceFileWithDir: typeof replaceFileWithDir;
		readonly updateSkill: typeof updateSkill;
	},
): void {
	// Notify capability captured at session_start (event-bus.ts pattern) —
	// captured BEFORE any early return so every mode (print one-shot, gated
	// child) can still surface shared-bus `request-attention` signals.
	let uiNotify: ExtensionUIContext["notify"] | undefined;

	// The H2 nudge leg shared by both handoff paths (D7/D13/D16): one hidden
	// followUp message; the pending-nudge flag is set only when the nudge
	// starts a run of its own — mid-stream it drains inside the running run
	// (R8), which then counts once, as usual.
	const sendHandoffNudge = (): void => {
		if (!state.agentRunActive) state.nudgeRunPending = true;
		// A handoff nudge is a diary nudge: the activity count starts over
		// (D18, amended).
		state.toolCallsSinceDiary = 0;
		// D21: while a curation checkpoint is still queued, the run this nudge
		// joins will drain it — point at the checkpoint instead of contradicting
		// it with "Start no new work". Same customType as the standard text.
		// Fire-and-forget by contract — pi owns the promise (E16).
		pi.sendMessage(
			{
				customType: HANDOFF_NUDGE_CUSTOM_TYPE,
				content: state.checkpointPending
					? HANDOFF_CHECKPOINT_NUDGE_TEXT
					: HANDOFF_NUDGE_TEXT,
				display: false,
			},
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	};

	// Shared gate read for both handoff paths (D5/D12/R3): bus listeners get
	// no ctx, so the child gate re-reads the env per event, like everywhere.
	const handoffNudgePermitted = (): boolean =>
		handoffNudgeAllowed({
			isChild: resolveChildWakeupGate(process.env).isChild,
			enabled:
				state.settings?.diaryOnHandoff ??
				DEFAULT_MEMPALACE_SETTINGS.diaryOnHandoff,
			diaryToolRegistered: diaryToolRegistered(pi),
		});

	// ── session_start — reset counter + load wake-up context + sync skills + ensure MCP ──
	pi.on("session_start", async (_event, ctx) => {
		// Release /handoff waits BEFORE reset: reset would drop the resolvers
		// and pi-handoff would sit out its full 120s (D15).
		releaseSettleWaiters(state);
		state.reset();
		uiNotify = ctx.ui.notify.bind(ctx.ui);
		// Capture this runtime's transcript file BEFORE any early return —
		// every session mines its own transcript at shutdown (file-granular,
		// targeting this capture), so the capture must exist on all paths.
		state.sessionFile = ctx.sessionManager.getSessionFile() ?? null;
		// Pre-warm config so session_shutdown can spawn synchronously — for
		// ALL sessions including print-mode one-shots (`pi -p`). Resolved
		// BEFORE the child gate and the print return: children and print
		// one-shots still mine their transcripts at shutdown and need the
		// palace config (PRD §4 A1 — over-gating here would silently kill
		// persistence). Config resolution is cheap (env/settings reads),
		// unlike the wake-up palace scan further below.
		state.config = await resolveMempalaceConfig(ctx.cwd);
		// Load settings BEFORE the child gate and the print return — children
		// and print one-shots gate recall/curation on this snapshot (same
		// all-paths rule as the config pre-warm above). One read per session:
		// settings changes take effect on the next session, mirroring how the
		// rest of pi consumes settings.
		state.settings = await readMempalaceSettings(ctx.cwd);
		// Print mode (plain `pi -p` one-shots) skips wake-up, skill sync, and
		// MCP registration — a text-print run only needs its transcript mined
		// at shutdown, which the pre-warmed config above enables. Curation
		// subagents are json-mode children, not print sessions, so they never
		// hit this return.
		if (ctx.mode === "print") return;

		// Subagent children skip wake-up/sync/MCP side effects (PRD §4 A1).
		// Evaluated per-event, never factory-frozen (PRD A3).
		const gate = resolveChildWakeupGate(process.env);
		if (gate.skipWakeUp) {
			logGateSkipOnce(state, gate.reason);
			return;
		}
		if (gate.hatchUsed) logHatchOnce(state, gate.reason);

		state.wakeUpContext = await wakeUp.execute(ctx.cwd);

		// Sync skills fire-and-forget. Swallow errors.
		syncSkills(skillInstaller).catch(() => {});

		// MCP registration is DISABLED (user decision 2026-09-01): both profiles
		// carry a static `mempalace` entry in mcp.json, which owns registration.
		// ensureMcp() has been a guaranteed skip since then — commented out so
		// the extension can never auto-register. Manual diagnostic:
		// /mempalace-mcp-status (its ensureMcp call can still register if no
		// static entry exists).
		// ensureMcp(pi, ctx.cwd, ctx.mode).catch(() => {});
	});

	// ── request-attention — pi-claude-sandbox's pre-prompt signal ────────────
	// Fired just before its interactive sandbox-permission prompt. Surfaced
	// as a transient ctx.ui.notify toast (warning): the toast self-clears,
	// which is the whole lifecycle story — the emitter sends no clear event.
	// The payload stays in-process (no telemetry/external sends). Before any
	// session_start (nothing captured yet) this is a safe no-op.
	pi.events.on("request-attention", (data) => {
		const { message } = parseRequestAttentionPayload(data);
		uiNotify?.(message, "warning");
	});

	// ── Manual sync command ─────────────────────────────────────────────────
	pi.registerCommand("mempalace-skills-sync", {
		description:
			"Force MemPalace skill sync (install/update skills from bundled versions)",
		handler: async (_args, ctx) => {
			const report: SkillSyncReport = await syncSkills(skillInstaller);

			const results = report.skills.map(
				({ skillName, action, success, error }) =>
					`${skillName}: ${action} ${success ? "✓" : "✗"}${error ? ` — ${error}` : ""}`,
			);

			ctx.ui.notify(`MemPalace skill sync:\n${results.join("\n")}`, "info");
		},
	});

	// MCP registration is manual (static mcp.json owns it — user decision
	// 2026-09-01). The status diagnostic below doubled as a register-if-absent
	// path, so it is disabled entirely.
	/*
	// ── Manual MCP status command ────────────────────────────────────────────
	pi.registerCommand("mempalace-mcp-status", {
		description:
			"Show MCP server status: palace path, binary, configured servers, registration action",
		handler: async (_args, ctx) => {
			let report;
			try {
				report = await ensureMcp(pi, ctx.cwd, ctx.mode);
			} catch (e) {
				ctx.ui.notify(
					`MemPalace MCP status failed: ${e instanceof Error ? e.message : String(e)}`,
					"error",
				);
				return;
			}

			const {
				action,
				palacePath,
				palaceSource,
				binaryPath,
				configuredServers,
				adapterAvailable,
				registered,
				error,
			} = report;

			const actionText =
				action.action === "register"
					? registered
						? `REGISTERED: ${action.name}`
						: `REGISTER FAILED: ${action.name}${error ? ` — ${error}` : ""}`
					: `SKIPPED: ${action.reason}`;

			const configNames = configuredServers
				.filter(
					(s) =>
						s.name === "mempalace" ||
						s.command?.includes("mempalace-mcp"),
				)
				.map((s) => s.name)
				.join(", ");

			const lines = [
				`Palace: ${palacePath} (${palaceSource})`,
				`Binary: ${binaryPath ?? "not found"}`,
				`Configured mempalace servers: ${configNames || "none"}`,
				`Adapter available: ${adapterAvailable ? "yes" : "no"}`,
				`Action: ${actionText}`,
			];

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
	*/

	// ── before_agent_start — wake-up as a prompt section + per-prompt recall ─
	// The wake-up context goes into `systemPromptOptions.sections.mempalace`
	// rather than a returned `systemPrompt`: a returned prompt forces the whole
	// system prompt for the run and defeats pi's transcript deltas. pi rebuilds
	// the options from base every turn, so the section is set on EVERY turn —
	// an unset turn would record a removal delta (and re-add churn after it).
	pi.on("before_agent_start", async (event, _ctx) => {
		// SAFETY: the handler type promises a full ExtensionContext, but some
		// hosts deliver a minimal ctx whose `cwd` is absent at runtime; the cast
		// only reads the property and `?? process.cwd()` covers a missing value.
		const cwd: string = (_ctx as unknown as { cwd: string }).cwd ?? process.cwd();

		// One-shot self-heal retry if wake-up failed at session_start.
		// Gated per-event for subagent children (PRD §4 A1) — print-mode
		// children reach wake-up exactly through this path, and the hatch is
		// re-evaluated at every event (PRD A3).
		const gate = resolveChildWakeupGate(process.env);
		if (gate.skipWakeUp) {
			logGateSkipOnce(state, gate.reason);
		} else if (!state.wakeUpContext && !state.wakeUpRetried) {
			state.wakeUpRetried = true;
			if (gate.hatchUsed) logHatchOnce(state, gate.reason);
			state.wakeUpContext = await wakeUp.execute(cwd);
		}

		if (state.wakeUpContext) {
			// Optional chain: pi < 0.86 delivers no systemPromptOptions at runtime.
			const sections = event.systemPromptOptions?.sections;
			if (sections) sections[WAKEUP_SECTION] = state.wakeUpContext;
			else logNoSectionsOnce(state);
		}

		// Short prompts ("yes", "go") skip recall only — the wake-up section
		// above is set regardless, so short turns don't flap the prompt.
		if (!event.prompt || event.prompt.length < 10) return;

		// Settings-driven recall gate: master switch + child opt-in. The hatch
		// above covers the wake-up leg ONLY — recall gating ignores it and reads
		// the session_start settings snapshot (null → defaults, as if freshly
		// parsed). Wake-up injection above stays fully independent of recall.
		const features = childFeatureGates(gate.isChild, state.settings);
		const recallResult = features.recall
			? await recall.execute(event.prompt, cwd)
			: null;

		const snippets = recallResult?.snippets ?? [];
		if (!recallResult || snippets.length === 0) return;

		return {
			message: {
				customType: RECALL_CUSTOM_TYPE,
				content: formatRecallContext(snippets),
				display: true,
				details: {
					count: snippets.length,
					wing: recallResult.wing,
					palace: recallResult.palace,
				},
			},
		};
	});

	// ── agent_end — periodic LLM curation every settings.saveInterval exchanges ──
	pi.on("agent_end", async (_event, ctx) => {
		// Keep the transcript capture current — shutdown mines it. Refreshing
		// here tracks a file that changed without a fresh session_start capture
		// (e.g. a same-manager branch swap before teardown); without this
		// refresh, shutdown mining would target a stale path in those flows.
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (sessionFile) state.sessionFile = sessionFile;
		// Nudge-run bookkeeping (D11): a run started by the settle nudge leaves
		// conversationCount untouched AND skips the checkpoint check — the
		// return must come before the increment, because a count already on a
		// multiple of save_interval would satisfy `count % interval === 0`
		// again and re-send curation. Only a read: the flag is cleared at
		// agent_settled, never here (R7).
		if (state.nudgeRunPending) return;
		state.conversationCount++;
		// Settings-driven curation gate: children skip the checkpoint unless
		// opted in via mempalace.children.curation; primary sessions always
		// checkpoint, every settings.saveInterval exchanges. Same per-event env
		// read as the recall gate; same settings snapshot (null → defaults).
		const features = childFeatureGates(
			resolveChildWakeupGate(process.env).isChild,
			state.settings,
		);
		if (!features.curation) return;
		const interval =
			state.settings?.saveInterval ?? DEFAULT_MEMPALACE_SETTINGS.saveInterval;
		if (state.conversationCount % interval !== 0) return;
		if (!sessionFile) return;

		const { prompt } = await curation.buildPrompt(
			ctx.cwd,
			state.conversationCount,
		);

		// In-session curation checkpoint (user decision 2026-09-01): the
		// current session files items itself — no subagent; it already has
		// the conversation in context.
		pi.sendMessage(
			{
				customType: "mempalace-autosave",
				content: prompt,
				display: false,
			},
			{ triggerTurn: true, deliverAs: "nextTurn" },
		);
		// D17: this run's settle must yield the diary nudge to the checkpoint —
		// the checkpoint prompt already asks for a diary write, and on pi ≥ 1.2
		// a nudge run drains the pending nextTurn checkpoint into itself.
		state.checkpointQueuedThisRun = true;
		// D21: the checkpoint stays PENDING past the settle — until the next
		// agent_start drains it — so a /handoff in between picks the
		// checkpoint-variant nudge text.
		state.checkpointPending = true;
	});

	// ── tool_execution_start — "already diarised" mark + activity count (D18) ──
	// The count accumulates across runs until a diary write or a diary nudge
	// (D18, amended): a diary-tool call is the write, so it zeroes the count.
	pi.on("tool_execution_start", (event) => {
		if (isDiaryToolName(event.toolName)) {
			state.diaryWrittenThisRun = true;
			state.toolCallsSinceDiary = 0;
			return;
		}
		state.toolCallsSinceDiary++;
	});

	// ── handoff bus — the "handoff in progress" window + the H2 nudge (D8/D9/D13–D16) ──
	// Both handoff paths open the window that keeps the settle nudge quiet
	// and send one hidden diary nudge before pi-handoff snapshots. The window
	// closes on `handoff_command_complete`, which fires on every exit path
	// (E10), and on the next interactive input (the input handler below).
	//  - `handoff_command_start{trigger:"handoff"}` — the /handoff leg below:
	//    registers a settle waiter with the payload's waitUntil, synchronously.
	//  - `handoff_tool_start` — the continue tool staged /continue: the nudge
	//    is a followUp in the streaming run, deduped per session (D6).
	// `tui_filled_handoff` keeps raising the window only: the installed
	// pi-handoff continue tool emits it right before auto-submit, and without
	// it H1 would start a diary run on the very settle the auto-submit presses
	// Enter on (R5) — best-effort, not a contract (D9). Window payloads are
	// ignored: bus listeners get no ctx and a malformed payload must not throw.
	pi.events.on(HANDOFF_CHANNELS.toolStart, () => {
		try {
			// Presence itself stages a continue — payloads carry no trigger,
			// and a malformed one must not throw.
			state.handoffInProgress = true;
			if (state.handoffToolNudged) return; // per-session dedupe (D6/R9)
			if (!handoffNudgePermitted()) return;
			state.handoffToolNudged = true;
			sendHandoffNudge();
		} catch {
			// Never throw from a hook.
		}
	});
	pi.events.on(HANDOFF_CHANNELS.tuiFilledHandoff, () => {
		state.handoffInProgress = true;
	});
	pi.events.on(HANDOFF_CHANNELS.commandComplete, () => {
		state.handoffInProgress = false;
	});
	// The /handoff leg (H2, D6/D13/D14/D15). pi.events is a plain EventEmitter
	// and pi-handoff closes wait registration when the emit returns, so this
	// listener stays synchronous — no async, no await before register().
	pi.events.on(HANDOFF_CHANNELS.commandStart, (data) => {
		try {
			const { trigger, register } = parseHandoffCommandStart(data);
			// D20 drift detection: an unrecognised shape means pi-handoff predates
			// the W2 contract (no trigger) or lost its waitUntil — the /handoff
			// diary turn cannot work there. Warn once per session, gated like the
			// nudge (H2 off or gates failing → it is not our turn to complain);
			// runs before the early returns below so it can never delay or
			// reorder the synchronous register() call.
			const drifted =
				trigger === null || (trigger === "handoff" && register === null);
			if (drifted && !state.handoffDriftWarned && handoffNudgePermitted()) {
				state.handoffDriftWarned = true;
				try {
					// Optional chain: before session_start nothing is captured —
					// the flag still latches so the first notify is the only one.
					uiNotify?.(HANDOFF_DRIFT_WARNING, "warning");
				} catch {
					// A failed toast must not throw from a hook.
				}
			}
			if (trigger !== "handoff") return; // bare /continue, missing or unknown trigger: nothing (D6/R2)
			// Raise the window BEFORE the gates: D8 keeps the settle nudge quiet
			// during a handoff even when H2 is switched off, and D14 keeps it
			// when waitUntil is missing.
			state.handoffInProgress = true;
			if (register === null) return; // D14: without the wait, pi-handoff would snapshot mid-diary-turn
			if (!handoffNudgePermitted()) return; // gates fail → no nudge → nothing to wait for either
			// Resolve-only promise (D15): released on the next settle, aborted
			// or not, and on teardown so pi-handoff never sits out its 120s.
			const settled = new Promise<void>((resolve) => {
				state.settleWaiters.push(resolve);
			});
			register(settled);
			// D19 self-bound: one unref'd timer per batch of waiters — if no
			// settle ever arrives (pi-handoff's 120s cap failing too), the waits
			// still release after 125s instead of hanging the handoff.
			if (state.settleWaiterTimer === null) {
				const timer = setTimeout(
					() => releaseSettleWaiters(state),
					HANDOFF_WAIT_SELF_BOUND_MS,
				);
				timer.unref?.();
				state.settleWaiterTimer = timer;
			}
			sendHandoffNudge();
		} catch {
			// Never throw from a hook — a lost nudge self-heals at the next
			// handoff or settle. An already-registered wait is still released
			// on the next settle, the self-bound, or session teardown (D15/D19);
			// a lost registration is bounded by pi-handoff's 120s cap.
		}
	});

	// ── agent_start — run-activity tracking for the handoff nudges (D13) ─────
	// Bus listeners get no ctx and extension commands can run mid-stream (E15),
	// so "is a run streaming?" is self-tracked: a handoff nudge sets the
	// pending-nudge flag only when this is false (it starts a run of its own).
	pi.on("agent_start", () => {
		state.agentRunActive = true;
		// D21: any run start drains the pending nextTurn checkpoint into the
		// run — a handoff nudge from here on describes a turn whose checkpoint
		// is no longer queued, so the standard text applies again.
		state.checkpointPending = false;
	});

	// ── agent_settled — one hidden diary nudge per qualifying settle (H1, D1) ──
	// The nudge is a hidden followUp custom message; when the agent is idle
	// pi defers the send until after these handlers and then runs it as its
	// own agent turn (E14), so this handler only decides and sends.
	pi.on("agent_settled", (event, ctx) => {
		try {
			// W2 prelude (D13/D15): the run is over, and every /handoff wait is
			// satisfied by this settle — aborted or not. pi-handoff owns the
			// 120s deadline, so resolving early is always safe.
			state.agentRunActive = false;
			releaseSettleWaiters(state);
			// SAFETY: the locked dev types (0.87.1) type agent_settled as
			// `{ type }` only, while the 1.1.0 runtime delivers `aborted`; the
			// structural read keeps tsc green against both (D10). Absent →
			// false, so an old host treats an aborted settle as a normal one.
			const aborted = (event as { aborted?: unknown }).aborted === true;
			// Snapshot then clear BEFORE any gate (D11/D18): the nudge run's
			// agent_end fires before its settle, so the pending flag must
			// survive until here — and must not leak into the next run.
			const nudgeRun = state.nudgeRunPending;
			const diaryWrittenThisRun = state.diaryWrittenThisRun;
			const checkpointQueued = state.checkpointQueuedThisRun;
			const toolCallsSinceDiary = state.toolCallsSinceDiary;
			state.nudgeRunPending = false;
			state.diaryWrittenThisRun = false;
			state.checkpointQueuedThisRun = false;
			// The activity count is NOT per run (D18, amended): it carries
			// across settles the gate skips, so short runs add up. A nudge run
			// is the diary turn and a queued checkpoint asks for the diary write,
			// so both start the count over; the nudge send below does too.
			if (nudgeRun || checkpointQueued) state.toolCallsSinceDiary = 0;
			if (
				!shouldNudgeOnSettle({
					aborted,
					mode: ctx.mode,
					isChild: resolveChildWakeupGate(process.env).isChild,
					enabled:
						state.settings?.diaryOnSettle ??
						DEFAULT_MEMPALACE_SETTINGS.diaryOnSettle,
					handoffInProgress: state.handoffInProgress,
					nudgeRun,
					diaryWrittenThisRun,
					checkpointQueued,
					toolCallsSinceDiary,
					minToolCalls:
						state.settings?.diarySettleMinToolCalls ??
						DEFAULT_MEMPALACE_SETTINGS.diarySettleMinToolCalls,
					diaryToolRegistered: diaryToolRegistered(pi),
				})
			)
				return;
			// Set before the send: the run the nudge may start must count as a
			// nudge run from its first agent_end (D11).
			state.nudgeRunPending = true;
			state.toolCallsSinceDiary = 0;
			// Fire-and-forget by contract — pi owns the promise (E16).
			pi.sendMessage(
				{
					customType: SETTLE_NUDGE_CUSTOM_TYPE,
					content: SETTLE_NUDGE_TEXT,
					display: false,
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		} catch {
			// Never throw from a hook — a lost nudge self-heals at the next
			// settle (R14).
		}
	});

	// ── input — the user's next interactive submission closes the handoff window (D8) ──
	// Extension commands (/handoff, /continue) never fire input and nudge runs
	// bypass prompt() entirely (E15), so only a real user submission lands
	// here. Returning nothing keeps the input unmodified — a returned result
	// would transform or swallow it.
	pi.on("input", (event) => {
		if (event.source === "interactive") state.handoffInProgress = false;
	});

	// ── session_before_compact — mine transcript before it is summarised ──────
	// File-granular: mine this runtime's captured transcript, not the whole
	// sessions dir (the CLI accepts one conversation file with --mode convos).
	pi.on("session_before_compact", async (_event, ctx) => {
		const sessionFile = state.sessionFile ?? ctx.sessionManager.getSessionFile();
		if (!sessionFile) return;
		await mining.mineSync(sessionFile, ctx.cwd);
	});

	// ── session_shutdown — persist transcript in background ──────────────────
	// Mines on quit AND session-replacement teardowns (new/resume/fork): the
	// outgoing runtime never fires quit again, so its transcript would go
	// unmined. `reload` is skipped: the same session continues (mined at
	// quit), and skipping avoids redundant spawns during extension-dev reloads.
	// File-granular: mines THIS runtime's captured transcript file (CLI
	// accepts one conversation file with --mode convos) instead of sweeping
	// the sessions dir — subagent children mine their own transcripts at
	// their own shutdown (PRD §4 A1). The state capture is mined, not the
	// live getter: a same-manager fork flip can swap the session manager
	// before teardown, so the getter may already expose the branched file.
	// Accepted corner: with a null capture (getter falsy at session_start and
	// no agent_end turn) while a flip swapped in the branched file, the
	// fallback resolves to the branched file and the outgoing transcript goes
	// unmined — same accepted class as crashed-session loss.
	// Idempotent by contract: `mempalace mine` skips already-mined files via
	// mtime + content-hash dedup (file_already_mined, convo_miner.py) — if
	// upstream ever changes that, this fires redundant mines per switch.
	// Fully synchronous: uses cached config + cached bin path so no
	// pending promises or I/O handles block process exit.
	pi.on("session_shutdown", (event, ctx) => {
		// Teardown must never hold pi-handoff for its full 120s (D15): release
		// the /handoff waits before the reload early return.
		releaseSettleWaiters(state);
		if (event.reason === "reload") return;
		if (!state.config) return;
		const sessionFile = state.sessionFile ?? ctx.sessionManager.getSessionFile();
		if (!sessionFile) return;
		mining.mineBackground(sessionFile, state.config);
	});
}
