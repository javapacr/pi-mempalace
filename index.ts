/**
 * MemPalace Recall Extension
 *
 * Palace-aware routing: reads `mempalace.yaml` in cwd to determine which
 * palace and wing to use. Falls back to a CVP palace for paths under
 * ~/Documents/projects/tml/cvp, and to the personal palace everywhere else.
 *
 * Active features (lifecycle hooks):
 * - session_start        — load wake-up context (L0+L1 ~940 tokens) into the
 *                          system prompt; reset conversation counter
 * - before_agent_start   — recall per-prompt memories and inject them into
 *                          the system prompt
 * - agent_end            — every SAVE_INTERVAL (15) exchanges, dispatch a
 *                          worker subagent for diary/drawer/KG curation
 * - session_before_compact — mine the session transcript before it is
 *                          summarised, preserving verbatim text in MemPalace
 * - session_shutdown     — background mine on quit
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

export default function mempalaceExtension(pi: ExtensionAPI): void {
	const state = new SessionState();
	const cli = new MempalaceCli();

	const wakeUp = new WakeUpUseCase(cli);
	const recall = new RecallUseCase(cli);
	const curation = new CurationUseCase();
	const mining = new MiningUseCase(cli);

	registerRecallRenderer(pi);
	registerMempalaceEvents(pi, state, wakeUp, recall, curation, mining);
}
