/**
 * Repair-FTS5 tool definition.
 *
 * NOT registered — call `pi.registerTool(createRepairFts5Tool(pi))` in
 * index.ts to re-enable. Kept here so the implementation is not lost.
 *
 * Delegates to tools/scripts/repair-fts5.py via python3.
 */

import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveMempalaceConfig } from "../domain/palace-router";

const execFileAsync = promisify(execFile);

// ── Helper ────────────────────────────────────────────────────────────────────

interface HealthSnapshot {
	ok: boolean;
	message: string;
	fts5_count: number;
	metadata_string_count: number;
}

interface RepairFts5Result {
	error?: string;
	backup?: string;
	action?: string;
	before?: HealthSnapshot;
	after?: HealthSnapshot;
	mempalace_repair?: { ok: boolean; output: string };
}

interface RepairOutput {
	ok: boolean;
	backup?: string;
	action?: string;
	before?: HealthSnapshot;
	after?: HealthSnapshot;
	mempalaceRepair?: { ok: boolean; output: string };
	details: string;
}

async function repairFts5(
	palace: string | undefined,
	backup: boolean,
	runRepair: boolean,
	repairTimeout: number,
): Promise<RepairOutput> {
	const targetPalace =
		palace ?? (await resolveMempalaceConfig(process.cwd())).palace;

	const args = [
		join(__dirname, "scripts", "repair-fts5.py"),
		"--palace",
		targetPalace,
	];
	if (!backup) args.push("--no-backup");
	if (runRepair) args.push("--repair");
	args.push("--repair-timeout", String(repairTimeout));

	const { stdout, stderr } = await execFileAsync("python3", args, {
		timeout: 600_000,
	});
	if (stderr && !stderr.trim().startsWith("{")) throw new Error(stderr.trim());

	let result: RepairFts5Result;
	try {
		result = JSON.parse(stdout.trim()) as RepairFts5Result;
	} catch {
		throw new Error(
			`Unexpected output from repair-fts5.py: ${stdout.slice(0, 200)}`,
		);
	}
	if (result.error) throw new Error(result.error);

	const lines: string[] = [];
	if (result.backup) lines.push(`Backup: ${result.backup}`);
	if (result.action) lines.push(`Action: ${result.action}`);
	if (result.before) {
		lines.push(
			`Before: quick_check=${result.before.ok ? "ok" : "fail"} ` +
				`fts5=${result.before.fts5_count.toLocaleString()} ` +
				`metadata_strings=${result.before.metadata_string_count.toLocaleString()}`,
		);
	}
	if (result.after) {
		lines.push(
			`After: quick_check=${result.after.ok ? "ok" : "fail"} ` +
				`fts5=${result.after.fts5_count.toLocaleString()} ` +
				`metadata_strings=${result.after.metadata_string_count.toLocaleString()}`,
		);
	}
	if (result.mempalace_repair) {
		lines.push(
			`mempalace repair: ${result.mempalace_repair.ok ? "ok" : "failed"} ` +
				`(${result.mempalace_repair.output.slice(0, 200)})`,
		);
	}

	return {
		ok: Boolean(
			result.after?.ok &&
				(!result.mempalace_repair || result.mempalace_repair.ok),
		),
		backup: result.backup,
		action: result.action,
		before: result.before,
		after: result.after,
		mempalaceRepair: result.mempalace_repair,
		details: lines.join("\n"),
	};
}

// ── Tool factory ──────────────────────────────────────────────────────────────

/**
 * Returns the tool definition object.
 * To register: `pi.registerTool(createRepairFts5Tool(pi))`
 */
export function createRepairFts5Tool(_pi: ExtensionAPI) {
	return {
		name: "mempalace_repair_fts5" as const,
		label: "Repair MemPalace FTS5 Index",
		description:
			"Rebuild the MemPalace ChromaDB FTS5 full-text index when SQLite " +
			"reports corruption such as 'malformed inverted index'. Backs up the " +
			"palace, recreates the FTS5 virtual table from embedding_metadata, and " +
			"verifies PRAGMA quick_check. Optionally runs `mempalace repair --yes`.",
		parameters: Type.Object({
			palace: Type.Optional(
				Type.String({
					description:
						"Path to the palace directory (defaults to active palace)",
				}),
			),
			backup: Type.Optional(
				Type.Boolean({
					default: true,
					description: "Create a timestamped backup of the palace first",
				}),
			),
			run_repair: Type.Optional(
				Type.Boolean({
					default: false,
					description:
						"Also run `mempalace repair --yes` after rebuilding FTS5",
				}),
			),
			repair_timeout: Type.Optional(
				Type.Integer({
					default: 600,
					description:
						"Timeout in seconds for `mempalace repair` (default: 600)",
				}),
			),
		}),
		async execute(
			_toolCallId: string,
			params: {
				palace?: string;
				backup?: boolean;
				run_repair?: boolean;
				repair_timeout?: number;
			},
			_signal: AbortSignal,
			_onUpdate: unknown,
			_ctx: unknown,
		) {
			const {
				palace,
				backup = true,
				run_repair: runRepair = false,
				repair_timeout: repairTimeout = 600,
			} = params;

			try {
				const { ok, details } = await repairFts5(
					palace,
					backup,
					runRepair,
					repairTimeout,
				);
				return {
					content: [
						{
							type: "text" as const,
							text: ok
								? `MemPalace FTS5 repair succeeded.\n\n${details}`
								: `MemPalace FTS5 repair completed with warnings.\n\n${details}`,
						},
					],
					details: { ok, palace },
				};
			} catch (err) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Failed to repair MemPalace FTS5 index: ${err}`,
						},
					],
					details: { error: String(err), palace },
				};
			}
		},
	};
}
