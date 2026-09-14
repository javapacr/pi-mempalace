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
 * - session_start        — load wake-up context (L0+L1 ~940 tokens) into the
 *                          system prompt; reset conversation counter; parse
 *                          mempalace settings (project .pi/settings.json over
 *                          profile, on all paths); sync skills; ensure MCP
 *                          registration — wake-up/sync/MCP SKIPPED for
 *                          subagent children (PI_SUBAGENT_CHILD=1) unless
 *                          the PI_MEMPALACE_CHILD_WAKEUP escape hatch applies
 * - before_agent_start   — recall per-prompt memories and inject them into
 *                          the system prompt; gated by settings
 *                          (recall_on_prompt master switch; children also
 *                          need children.recall, default off) — wake-up
 *                          self-heal retry stays child-gated via the hatch
 * - agent_end            — every save_interval (default 15) exchanges,
 *                          inject an in-session curation checkpoint;
 *                          subagent children skip it unless
 *                          children.curation is set (default off)
 * - session_before_compact — mine the session transcript before it is
 *                          summarised, preserving verbatim text in MemPalace
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
import { registerRecallRenderer } from "./ui/recall-renderer";
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
	registerMempalaceEvents(pi, state, wakeUp, recall, curation, mining, {
		readSkillDirState: skillInstaller.readSkillDirState,
		installSkill: skillInstaller.installSkill,
		replaceSymlinkWithDir: skillInstaller.replaceSymlinkWithDir,
		replaceFileWithDir: skillInstaller.replaceFileWithDir,
		updateSkill: skillInstaller.updateSkill,
	});
}
