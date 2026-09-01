/**
 * WakeUpUseCase — loads the MemPalace wake-up context at session start.
 *
 * Produces the L0+L1 summary (~940 tokens) that is injected into the system
 * prompt for the whole session. The CLI wake-up text is passed through
 * untouched — no wing-policy line is appended extension-side (extensions ship
 * mechanism, not palace-organization policy; wing-routing knowledge comes
 * from MemPalace core tool descriptions and user-side docs).
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
			return body;
		} catch {
			return null;
		}
	}
}
