/**
 * MemPalace Recall Extension
 *
 * Palace-aware routing: reads `mempalace.yaml` in cwd to determine which
 * palace and wing to use. Falls back to a CVP palace for paths under
 * ~/Documents/projects/tml/cvp, and to the personal palace everywhere else.
 * The personal palace default now uses the env → settings → home-relative
 * chain (Aug 8 backlog resolution).
 *
 * Active features (lifecycle hooks):
 * - session_start        — new session: fetch the wake-up context (L0+L1
 *                          ~940 tokens); resume/restart/reload/fork: reuse
 *                          the wake-up text saved in the session entries,
 *                          no fetch; reset conversation counter; parse
 *                          mempalace settings (project .pi/settings.json over
 *                          profile, on all paths); sync skills; ensure MCP
 *                          registration — wake-up/sync/MCP SKIPPED for
 *                          subagent children (PI_SUBAGENT_CHILD=1) unless
 *                          the PI_MEMPALACE_CHILD_WAKEUP escape hatch applies
 * - before_agent_start   — insert the wake-up text as ONE persisted
 *                          `mempalace-wakeup` conversation message when the
 *                          model context has none (first run of a new
 *                          session, or the first run after a compaction
 *                          summarised it away — the SAME saved text, no
 *                          re-fetch); never a system-prompt
 *                          section, so the system prompt stays byte-identical
 *                          all session; one-shot self-heal fetch when
 *                          session_start had none, child-gated via the
 *                          hatch. Then recall per-prompt memories as a
 *                          custom message; recall gated by settings
 *                          (recall_on_prompt master switch; children also
 *                          need children.recall, default off)
 * - agent_end            — every save_interval (default 15) exchanges,
 *                          inject an in-session curation checkpoint;
 *                          subagent children skip it unless
 *                          children.curation is set (default off);
 *                          runs started by the settle nudge never
 *                          advance the exchange counter
 * - agent_settled        — after every settled TUI run once at least
 *                          diary_settle_min_tool_calls (default 3) tool
 *                          calls accumulated since the last diary write
 *                          or nudge, send one hidden
 *                          diary nudge (write one MemPalace diary entry
 *                          if anything durable happened, else reply one
 *                          short line and stop); gated by
 *                          diary_on_settle, subagent-child env, run mode,
 *                          a handoff in progress, an aborted settle, a
 *                          run that already diarised, and diary-tool
 *                          presence (suffix `mempalace_diary_write`,
 *                          active ∪ all tools)
 * - handoff events       — pi-handoff paths send one hidden handoff diary
 *                          nudge before the snapshot: /handoff
 *                          (handoff_command_start, trigger "handoff")
 *                          registers a settle waiter so pi-handoff waits
 *                          for the diary turn (120s cap owned by
 *                          pi-handoff, 125s self-bound here); the continue tool's
 *                          handoff_tool_start queues the same nudge as a
 *                          followUp, deduped per session. Gated by
 *                          diary_on_handoff, diary-tool presence and the
 *                          child gate; both paths raise the
 *                          handoff-in-progress window that keeps the
 *                          settle nudge quiet
 * - session_before_compact — mine the session transcript before it is
 *                          summarised, preserving verbatim text in MemPalace
 *                          (transcripts MemPalace would ingest as raw JSON —
 *                          system prompt + tool schemas — are skipped)
 * - session_shutdown     — background mine on quit and on session
 *                          replacement (new/resume/fork; not reload —
 *                          that session continues and is mined at quit)
 *
 * Manual commands:
 * - /mempalace-skills-sync  — force skill sync
 * - /mempalace-mcp-status   — show MCP server registration status
 *
 * Dormant tools (code kept, NOT registered):
 * - mempalace_delete_wing  — see tools/delete-wing.tool.ts
 * - mempalace_repair_fts5  — see tools/repair-fts5.tool.ts
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SessionState } from "./domain/types";
import { MempalaceCli } from "./infrastructure/mempalace-cli";
import { registerMempalaceEvents } from "./infrastructure/event-registration";
import {
	registerRecallRenderer,
	registerWakeUpRenderer,
} from "./ui/recall-renderer";
import { WakeUpUseCase } from "./application/wake-up.usecase";
import { RecallUseCase } from "./application/recall.usecase";
import { CurationUseCase } from "./application/curation.usecase";
import { MiningUseCase } from "./application/mining.usecase";
import { syncSkills } from "./application/skill-sync.usecase";
import * as skillInstaller from "./infrastructure/skill-installer";

export default function mempalaceExtension(pi: ExtensionAPI): void {
	const state = new SessionState();
	const cli = new MempalaceCli();

	const wakeUp = new WakeUpUseCase(cli);
	const recall = new RecallUseCase(cli);
	const curation = new CurationUseCase();
	const mining = new MiningUseCase(cli);

	registerRecallRenderer(pi);
	registerWakeUpRenderer(pi);
	registerMempalaceEvents(pi, state, wakeUp, recall, curation, mining, {
		readSkillDirState: skillInstaller.readSkillDirState,
		installSkill: skillInstaller.installSkill,
		replaceSymlinkWithDir: skillInstaller.replaceSymlinkWithDir,
		replaceFileWithDir: skillInstaller.replaceFileWithDir,
		updateSkill: skillInstaller.updateSkill,
	});
}
