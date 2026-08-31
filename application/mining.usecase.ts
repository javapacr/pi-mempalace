/**
 * MiningUseCase — mines session transcripts into MemPalace.
 *
 * File-granular: each call mines ONE session transcript file (the CLI
 * positional accepts a directory or, with --mode convos, a single
 * conversation file). Every session mines its own transcript; subagent
 * children mine theirs at their own shutdown.
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
	async mineSync(sessionFile: string, cwd: string): Promise<void> {
		const config = await resolveMempalaceConfig(cwd);
		try {
			await this.cli.run(
				["mine", sessionFile, "--mode", "convos", "--wing", "sessions"],
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
	mineBackground(sessionFile: string, config: MempalaceConfig): void {
		this.cli.spawnBackground(
			["mine", sessionFile, "--mode", "convos", "--wing", "sessions"],
			config,
		);
	}
}
