/**
 * CurationUseCase — builds the in-session curation checkpoint prompt.
 *
 * Pure orchestration: resolves the active palace config, best-effort resolves
 * the session repo's wing hint, then delegates prompt construction to the
 * domain layer.
 */

import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";
import { resolveMempalaceConfig } from "../domain/palace-router";
import { buildCurationPrompt } from "../domain/curation-prompt";
import type { MempalaceConfig } from "../domain/types";

const execFileAsync = promisify(execFile);

/**
 * Best-effort repo name from the session cwd — never throws into the
 * checkpoint path. Prefers the origin remote's repo name (forge-suffix only
 * where the URL carries one), falling back to the worktree toplevel basename.
 * Hint only: the model decides the wing (no repo→wing mapping table by
 * design).
 */
async function resolveRepoWingHint(cwd: string): Promise<string | undefined> {
	try {
		const { stdout } = await execFileAsync(
			"git",
			["-C", cwd, "remote", "get-url", "origin"],
			{ timeout: 2000 },
		);
		return basename(stdout.trim().replace(/\.git$/, ""));
	} catch {
		try {
			const { stdout } = await execFileAsync(
				"git",
				["-C", cwd, "rev-parse", "--show-toplevel"],
				{ timeout: 2000 },
			);
			return basename(stdout.trim()) || undefined;
		} catch {
			return undefined;
		}
	}
}

export class CurationUseCase {
	async buildPrompt(
		cwd: string,
		exchangeCount: number,
	): Promise<{ prompt: string; config: MempalaceConfig }> {
		const config = await resolveMempalaceConfig(cwd);
		const repoWingHint = await resolveRepoWingHint(cwd);
		return {
			prompt: buildCurationPrompt(config, exchangeCount, repoWingHint),
			config,
		};
	}
}
