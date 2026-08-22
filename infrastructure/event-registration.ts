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
import { formatRecallContext } from "../domain/recall-parser";
import type { WakeUpUseCase } from "../application/wake-up.usecase";
import type { RecallUseCase } from "../application/recall.usecase";
import type { CurationUseCase } from "../application/curation.usecase";
import type { MiningUseCase } from "../application/mining.usecase";
import { syncSkills } from "../application/skill-sync.usecase";

export function registerMempalaceEvents(
	pi: ExtensionAPI,
	state: SessionState,
	wakeUp: WakeUpUseCase,
	recall: RecallUseCase,
	curation: CurationUseCase,
	mining: MiningUseCase,
	skillInstaller: {
		readonly readSkillDirState: any;
		readonly installSkill: any;
		readonly replaceSymlinkWithDir: any;
		readonly updateSkill: any;
	},
): void {
	// ── session_start — reset counter + load wake-up context + sync skills ─────────────
	pi.on("session_start", async (_event, ctx) => {
		state.reset();
		// Skip wake-up in print mode — we're a curation subprocess.
		if (ctx.mode === "print") return;
		// Pre-warm config so session_shutdown can spawn synchronously.
		state.config = await resolveMempalaceConfig(ctx.cwd);
		state.wakeUpContext = await wakeUp.execute(ctx.cwd);

		// Sync skills fire-and-forget. Swallow errors.
		syncSkills(skillInstaller).catch(() => {});
	});

	// ── before_agent_start — inject memories + wake-up into system prompt ────
	pi.on("before_agent_start", async (event, _ctx) => {
		if (!event.prompt || event.prompt.length < 10) return;

		const cwd: string =
			(_ctx as unknown as { cwd: string }).cwd ?? process.cwd();
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
	// session_shutdown (quit only) — persist transcript in background.
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
