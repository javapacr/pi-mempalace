/**
 * WakeUpUseCase — loads the MemPalace wake-up context at session start.
 *
 * Produces the L0+L1 summary (~940 tokens) that is injected into the system
 * prompt for the whole session. A repo-wing diary convention line is appended
 * extension-side — pi agents otherwise only learn the convention via
 * mempalace_status (BRD P2 §11 sibling); the CLI text is passed through
 * untouched.
 */

import type { MempalaceCli } from "../infrastructure/mempalace-cli";
import { resolveMempalaceConfig } from "../domain/palace-router";

export class WakeUpUseCase {
	constructor(private readonly cli: MempalaceCli) {}

	/** Returns the wake-up text, or null if unavailable / print mode. */
	async execute(cwd: string): Promise<string | null> {
		const config = await resolveMempalaceConfig(cwd);
		const args = ["wake-up"];
		if (config.wing) args.push("--wing", config.wing);

		try {
			const out = await this.cli.run(args, config, 60_000);
			const body = out.trim();
			if (!body) return null;
			return (
				body +
				"\n" +
				"Diary/checkpoint wing convention: repo-anchored work files under the repo's wing (match the existing wing name); personal/cross-repo items go to your agent wing; the sessions wing is for mined transcripts, not diaries."
			);
		} catch {
			return null;
		}
	}
}
