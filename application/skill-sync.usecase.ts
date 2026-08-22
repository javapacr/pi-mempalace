/**
 * MemPalace skill sync use case — orchestrates skill installation/updates.
 *
 * Checks each managed skill (mempalace, mempalace-recall) against the bundled
 * versions and applies the appropriate action. Returns per-skill results.
 * Never throws to caller — collects errors in results.
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SkillPlan, SkillAction } from "../domain/skill-sync";
import { buildSkillPlan, hashContent } from "../domain/skill-sync";
import type {
	readSkillDirState,
	installSkill,
	replaceSymlinkWithDir,
	updateSkill,
} from "../infrastructure/skill-installer";

const __filename = fileURLToPath(import.meta.url);
const __dirname = join(__filename, "..");

/** Skills managed by this extension. */
const MANAGED_SKILLS = ["mempalace", "mempalace-recall"] as const;

export interface SkillSyncResult {
	readonly skillName: string;
	readonly action: SkillAction;
	readonly success: boolean;
	readonly error?: string;
}

export interface SkillSyncReport {
	readonly skills: readonly SkillSyncResult[];
	readonly timestamp: string;
}

/**
 * Sync all managed skills.
 *
 * Loads bundled SKILL.md content from the repo's skills/ directory,
 * checks installed state, applies actions, and returns a report.
 */
export async function syncSkills(
	installer: {
		readonly readSkillDirState: typeof readSkillDirState;
		readonly installSkill: typeof installSkill;
		readonly replaceSymlinkWithDir: typeof replaceSymlinkWithDir;
		readonly updateSkill: typeof updateSkill;
	},
): Promise<SkillSyncReport> {
	const results: SkillSyncResult[] = [];

	for (const skillName of MANAGED_SKILLS) {
		const result = await syncOneSkill(skillName, installer);
		results.push(result);
	}

	return {
		skills: results,
		timestamp: new Date().toISOString(),
	};
}

/**
 * Sync a single skill with error swallowing.
 */
async function syncOneSkill(
	skillName: string,
	installer: {
		readonly readSkillDirState: typeof readSkillDirState;
		readonly installSkill: typeof installSkill;
		readonly replaceSymlinkWithDir: typeof replaceSymlinkWithDir;
		readonly updateSkill: typeof updateSkill;
	},
): Promise<SkillSyncResult> {
	try {
		// Load bundled content.
		const bundledPath = join(__dirname, "..", "skills", skillName, "SKILL.md");
		const bundledContent = (
			await (await import("node:fs/promises")).readFile(bundledPath, "utf8")
		).trim();

		// Read installed state.
		const state = await installer.readSkillDirState(skillName);

		// Build plan.
		const plan = buildSkillPlan(skillName, bundledContent, state);

		// Apply action.
		await applyPlan(plan, bundledContent, hashContent(bundledContent), installer);

		return {
			skillName,
			action: plan.action,
			success: true,
		};
	} catch (error) {
		return {
			skillName,
			action: "NOOP" as SkillAction,
			success: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

/**
 * Execute a skill sync plan.
 */
async function applyPlan(
	plan: SkillPlan,
	bundledContent: string,
	bundledHash: string,
	installer: {
		readonly installSkill: typeof installSkill;
		readonly replaceSymlinkWithDir: typeof replaceSymlinkWithDir;
		readonly updateSkill: typeof updateSkill;
	},
): Promise<void> {
	switch (plan.action) {
		case "INSTALL":
			await installer.installSkill(plan.skillName, bundledContent, bundledHash);
			break;
		case "REPLACE_SYMLINK":
			await installer.replaceSymlinkWithDir(
				plan.skillName,
				bundledContent,
				bundledHash,
			);
			break;
		case "UPDATE":
			await installer.updateSkill(plan.skillName, bundledContent, bundledHash);
			break;
		case "NOOP":
			// Nothing to do.
			break;
	}
}