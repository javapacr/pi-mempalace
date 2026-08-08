/**
 * Delete-wing tool definition.
 *
 * NOT registered — call `pi.registerTool(createDeleteWingTool(pi))` in
 * index.ts to re-enable. Kept here so the implementation is not lost.
 *
 * Delegates to tools/scripts/delete-wing.py via python3.
 */

import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { Type } from "typebox";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { resolveMempalaceConfig } from "../domain/palace-router";

const execFileAsync = promisify(execFile);

// ── Helper ────────────────────────────────────────────────────────────────────

interface DeleteWingResult {
	total_deleted?: number;
	error?: string;
	collections?: Record<string, { count?: number; deleted?: number }>;
}

async function deleteWing(
	wing: string,
	palace: string | undefined,
	dryRun: boolean,
	confirm: boolean,
): Promise<{ total: number; details: string; deleted?: boolean }> {
	const targetPalace =
		palace ?? (await resolveMempalaceConfig(process.cwd())).palace;

	const args = [
		join(__dirname, "scripts", "delete-wing.py"),
		"--wing",
		wing,
		"--palace",
		targetPalace,
	];
	if (dryRun) args.push("--dry-run");

	const { stdout, stderr } = await execFileAsync("python3", args, {
		timeout: 300_000,
	});
	if (stderr && !stderr.trim().startsWith("{")) throw new Error(stderr.trim());

	let result: DeleteWingResult;
	try {
		result = JSON.parse(stdout.trim()) as DeleteWingResult;
	} catch {
		throw new Error(
			`Unexpected output from delete-wing.py: ${stdout.slice(0, 200)}`,
		);
	}
	if (result.error) throw new Error(result.error);

	const total = result.total_deleted ?? 0;
	const lines: string[] = [];
	for (const [name, data] of Object.entries(result.collections ?? {})) {
		const count = data.count ?? 0;
		const deleted = data.deleted ?? 0;
		lines.push(
			`${name}: ${count.toLocaleString()}` +
				(!dryRun && confirm ? ` (deleted ${deleted.toLocaleString()})` : ""),
		);
	}
	return { total, deleted: !dryRun && confirm, details: lines.join("\n") };
}

// ── Tool factory ──────────────────────────────────────────────────────────────

/**
 * Returns the tool definition object.
 * To register: `pi.registerTool(createDeleteWingTool(pi))`
 */
export function createDeleteWingTool(_pi: ExtensionAPI) {
	return {
		name: "mempalace_delete_wing" as const,
		label: "Delete MemPalace Wing",
		description:
			"Delete all drawers and closets in a MemPalace wing. " +
			"By default runs in dry-run mode and returns counts. " +
			"Pass dry_run=false and confirm=true to actually delete.",
		parameters: Type.Object({
			wing: Type.String({ description: "Name of the wing to delete" }),
			palace: Type.Optional(
				Type.String({
					description:
						"Path to the palace directory (defaults to active palace)",
				}),
			),
			dry_run: Type.Optional(
				Type.Boolean({
					default: true,
					description: "When true, only count what would be deleted",
				}),
			),
			confirm: Type.Optional(
				Type.Boolean({
					default: false,
					description:
						"Must be true to perform actual deletion; ignored when dry_run=true",
				}),
			),
		}),
		async execute(
			_toolCallId: string,
			params: {
				wing: string;
				palace?: string;
				dry_run?: boolean;
				confirm?: boolean;
			},
			_signal: AbortSignal,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		) {
			const { wing, palace, dry_run: dryRun = true, confirm = false } = params;

			if (!dryRun && !confirm) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Refusing to delete wing '${wing}': confirm=true is required when dry_run=false.`,
						},
					],
					details: {},
				};
			}

			if (!dryRun && confirm) {
				const ok = await ctx.ui.confirm(
					"Delete MemPalace wing?",
					`Permanently delete all drawers/closets in wing '${wing}'? This cannot be undone.`,
				);
				if (!ok) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Deletion of wing '${wing}' cancelled by user.`,
							},
						],
						details: {},
					};
				}
			}

			try {
				const { total, details, deleted } = await deleteWing(
					wing,
					palace,
					dryRun,
					confirm,
				);
				const action = deleted ? "Deleted" : "Would delete";
				return {
					content: [
						{
							type: "text" as const,
							text: `${action} ${total.toLocaleString()} items in wing '${wing}'.\n\n${details}`,
						},
					],
					details: { wing, total, deleted },
				};
			} catch (err) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Failed to delete wing '${wing}': ${err}`,
						},
					],
					details: { error: String(err) },
				};
			}
		},
	};
}
