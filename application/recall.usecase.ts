/**
 * RecallUseCase — searches MemPalace for memories relevant to a prompt.
 *
 * Runs `mempalace search`, parses the scored output, and returns filtered
 * snippets that meet the similarity threshold.
 */

import type { MempalaceCli } from "../infrastructure/mempalace-cli";
import { resolveMempalaceConfig } from "../domain/palace-router";
import { parseSearchSnippets } from "../domain/recall-parser";
import {
	SIMILARITY_THRESHOLD,
	MAX_RESULTS,
	MAX_SNIPPET_LEN,
	type SearchResult,
} from "../domain/types";

export class RecallUseCase {
	constructor(private readonly cli: MempalaceCli) {}

	async execute(prompt: string, cwd: string): Promise<SearchResult> {
		const config = await resolveMempalaceConfig(cwd);
		const args = ["search", prompt, "--results", String(MAX_RESULTS)];
		if (config.wing) args.push("--wing", config.wing);

		let raw: string;
		try {
			raw = await this.cli.run(args, config);
		} catch {
			return { snippets: [], wing: config.wing, palace: config.palace };
		}

		const snippets = parseSearchSnippets(
			raw,
			SIMILARITY_THRESHOLD,
			MAX_SNIPPET_LEN,
		);
		return { snippets, wing: config.wing, palace: config.palace };
	}
}
