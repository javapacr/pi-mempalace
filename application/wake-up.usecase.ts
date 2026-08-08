/**
 * WakeUpUseCase — loads the MemPalace wake-up context at session start.
 *
 * Produces the L0+L1 summary (~940 tokens) that is injected into the system
 * prompt for the whole session.
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
			const out = await this.cli.run(args, config);
			return out.trim() || null;
		} catch {
			return null;
		}
	}
}
