/**
 * Event registration — binds MemPalace lifecycle hooks to the pi ExtensionAPI.
 *
 * All pi.on() calls live here. Each handler is thin: it delegates to the
 * appropriate use case and maps the result back to pi's return shape.
 */

import { dirname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	SAVE_INTERVAL,
	RECALL_CUSTOM_TYPE,
	type SessionState,
} from "../domain/types";
import { resolveMempalaceConfig } from "../domain/palace-router";
import { resolveChildWakeupGate } from "../domain/child-gate";
import { formatRecallContext } from "../domain/recall-parser";
import type { WakeUpUseCase } from "../application/wake-up.usecase";
import type { RecallUseCase } from "../application/recall.usecase";
import type { CurationUseCase } from "../application/curation.usecase";
import type { MiningUseCase } from "../application/mining.usecase";
import type { SkillSyncReport } from "../application/skill-sync.usecase";
import { syncSkills } from "../application/skill-sync.usecase";
import { ensureMcp } from "../application/mcp-ownership.usecase";
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
	// ── session_start — reset counter + load wake-up context + sync skills + ensure MCP ──
	pi.on("session_start", async (_event, ctx) => {
		state.reset();
		// Skip wake-up in print mode — we're a curation subprocess.
		if (ctx.mode === "print") return;
		// Pre-warm config so session_shutdown can spawn synchronously. Resolved
		// BEFORE the child gate: children still mine their transcripts at
		// shutdown and need the palace config (PRD §4 A1 — over-gating here
		// would silently kill child persistence).
		state.config = await resolveMempalaceConfig(ctx.cwd);

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

		// Ensure MCP server registration fire-and-forget. Swallow errors.
		ensureMcp(pi, ctx.cwd, ctx.mode).catch(() => {});
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

	// ── before_agent_start — inject memories + wake-up into system prompt ────
	pi.on("before_agent_start", async (event, _ctx) => {
		if (!event.prompt || event.prompt.length < 10) return;

		const cwd: string =
			(_ctx as unknown as { cwd: string }).cwd ?? process.cwd();

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

		const { snippets, wing, palace } = await recall.execute(event.prompt, cwd);

		const hasRecall = snippets.length > 0;
		const hasWakeUp = Boolean(state.wakeUpContext);
		if (!hasRecall && !hasWakeUp) return;

		const systemPrompt = hasWakeUp
			? `${event.systemPrompt}\n\n[MemPalace Session Context]\n${state.wakeUpContext}`
			: undefined;

		const context = hasRecall ? formatRecallContext(snippets) : undefined;

		return {
			...(context && {
				message: {
					customType: RECALL_CUSTOM_TYPE,
					content: context,
					display: true,
					details: { count: snippets.length, wing, palace },
				},
			}),
			...(systemPrompt && { systemPrompt }),
		};
	});

	// ── agent_end — periodic LLM curation every SAVE_INTERVAL exchanges ──────
	pi.on("agent_end", async (_event, ctx) => {
		state.conversationCount++;
		if (state.conversationCount % SAVE_INTERVAL !== 0) return;
		if (!ctx.sessionManager.getSessionFile()) return;

		const { prompt } = await curation.buildPrompt(
			ctx.cwd,
			state.conversationCount,
		);

		pi.sendMessage(
			{
				customType: "mempalace-autosave",
				content:
					`Dispatch worker curation subagent:\n` +
					`subagent({ agent: "worker", context: "fork", async: true, task: ${JSON.stringify(prompt)} })`,
				display: false,
			},
			{ triggerTurn: true, deliverAs: "nextTurn" },
		);
	});

	// ── session_before_compact — mine transcript before it is summarised ──────
	pi.on("session_before_compact", async (_event, ctx) => {
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (!sessionFile) return;
		await mining.mineSync(dirname(sessionFile), ctx.cwd);
	});

	// ── session_shutdown (quit only) — persist transcript in background ───────
	// Fully synchronous: uses cached config + cached bin path so no
	// pending promises or I/O handles block process exit.
	pi.on("session_shutdown", (event, ctx) => {
		if (event.reason !== "quit") return;
		if (!state.config) return;
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (!sessionFile) return;
		mining.mineBackground(dirname(sessionFile), state.config);
	});
}
