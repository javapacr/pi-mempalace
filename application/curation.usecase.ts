/**
 * CurationUseCase — builds the worker subagent curation prompt.
 *
 * Pure orchestration: resolves the active palace config, then delegates
 * prompt construction to the domain layer.
 */

import { resolveMempalaceConfig } from "../domain/palace-router";
import { buildCurationPrompt } from "../domain/curation-prompt";
import type { MempalaceConfig } from "../domain/types";

export class CurationUseCase {
	async buildPrompt(
		cwd: string,
		exchangeCount: number,
	): Promise<{ prompt: string; config: MempalaceConfig }> {
		const config = await resolveMempalaceConfig(cwd);
		return { prompt: buildCurationPrompt(config, exchangeCount), config };
	}
}
