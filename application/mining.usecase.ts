/**
 * MiningUseCase — mines session transcripts into MemPalace.
 *
 * Two modes:
 *  - mineSync:       awaited, used before compaction so verbatim text is
 *                    preserved before the session is summarised.
 *  - mineBackground: fire-and-forget, used on session shutdown.
 */

import type { MempalaceCli } from "../infrastructure/mempalace-cli";
import { resolveMempalaceConfig } from "../domain/palace-router";
import type { MempalaceConfig } from "../domain/types";

export class MiningUseCase {
	constructor(private readonly cli: MempalaceCli) {}

	/** Synchronous mine — awaits completion. Non-fatal on failure. */
	async mineSync(dir: string, cwd: string): Promise<void> {
		const config = await resolveMempalaceConfig(cwd);
		try {
			await this.cli.run(
				["mine", dir, "--mode", "convos", "--wing", "sessions"],
				config,
			);
		} catch {
			// Non-fatal: don't block compaction because mining failed.
		}
	}

	/**
	 * Background mine — fire-and-forget. Used on quit and on session-replacement
	 * teardowns (new/resume/fork); reload is skipped (same session continues).
	 *
	 * Takes a pre-resolved config so the shutdown path is fully
	 * synchronous: no file reads, no promises, no lingering handles.
	 */
	mineBackground(dir: string, config: MempalaceConfig): void {
		this.cli.spawnBackground(
			["mine", dir, "--mode", "convos", "--wing", "sessions"],
			config,
		);
	}
}
