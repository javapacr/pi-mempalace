/**
 * MempalaceCli — infrastructure wrapper around the `mempalace` CLI binary.
 *
 * Handles binary resolution, argument construction, synchronous execution,
 * and fire-and-forget background spawning.
 */

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { MempalaceConfig } from "../domain/types";
import { resolveMempalaceConfig } from "../domain/palace-router";

const execFileAsync = promisify(execFile);

/** Module-level cache — resolved once per process. */
let _bin: string | null = null;

export class MempalaceCli {
	/** Resolve the mempalace binary path (cached after first call). */
	async getBin(): Promise<string> {
		if (_bin) return _bin;
		try {
			const { stdout } = await execFileAsync("which", ["mempalace"], {
				timeout: 3000,
			});
			_bin = stdout.trim();
		} catch {
			_bin = "mempalace"; // fall back to PATH lookup at spawn time
		}
		return _bin;
	}

	/**
	 * Build CLI args, always inserting `--palace <path>` so the CLI binary's
	 * hardcoded default (~/.mempalace/palace) is never relied upon.
	 */
	buildArgs(config: MempalaceConfig, opArgs: string[]): string[] {
		return ["--palace", config.palace].concat(opArgs);
	}

	/** Run mempalace CLI synchronously (awaited). Throws on non-zero exit. */
	async run(args: string[], config?: MempalaceConfig): Promise<string> {
		const bin = await this.getBin();
		const effectiveConfig =
			config ?? (await resolveMempalaceConfig(process.cwd()));
		const cliArgs = this.buildArgs(effectiveConfig, args);
		const { stdout } = await execFileAsync(bin, cliArgs, { timeout: 15000 });
		return stdout;
	}

	/**
	 * Spawn mempalace as a detached background process — fire-and-forget.
	 *
	 * Uses the cached bin path (warmed at session_start via getBin()).
	 * The spawn happens synchronously in the call stack so no pending
	 * promise or async I/O handle lingers to block event-loop drain.
	 */
	spawnBackground(args: string[], config: MempalaceConfig): void {
		const bin = _bin ?? "mempalace";
		try {
			const child = spawn(bin, this.buildArgs(config, args), {
				detached: true,
				stdio: "ignore",
			});
			child.on("error", () => {}); // suppress unhandled ENOENT
			child.unref();
		} catch {
			// best-effort
		}
	}
}
