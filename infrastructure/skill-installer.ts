/**
 * Filesystem operations for MemPalace skill installation.
 *
 * Wraps all I/O for skill sync: read/write skills, detect symlinks,
 * atomic file replacement, marker management. Never touches ~/.agents/
 * or ~/.agents/.skill-lock.json.
 */

import { readFile, lstat, mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SkillDirState, Marker } from "../domain/skill-sync";
import { MARKER_FILE, hashContent } from "../domain/skill-sync";

const SKILL_FILE = "SKILL.md";

/**
 * Default target directory for pi agent skills.
 */
const DEFAULT_AGENT_SKILLS_DIR = join(
	process.env.HOME ?? process.env.USERPROFILE ?? ".",
	".pi",
	"agent",
	"skills",
);

/**
 * Read the state of a skill installation directory.
 *
 * Never throws — returns a safe default observation.
 */
export async function readSkillDirState(
	skillName: string,
	baseDir: string = DEFAULT_AGENT_SKILLS_DIR,
): Promise<SkillDirState> {
	const skillPath = join(baseDir, skillName);

	try {
		const stat = await lstat(skillPath);

		if (stat.isSymbolicLink()) {
			// Symlink — don't follow into ~/.agents/.
			return {
				exists: true,
				isSymlink: true,
				isDir: false,
				skillHash: null,
				marker: null,
			};
		}

		if (!stat.isDirectory()) {
			return {
				exists: true,
				isSymlink: false,
				skillHash: null,
				marker: null,
				isDir: false,
			};
		}

		// Real directory — read SKILL.md and marker.
		const [skillContent, markerContent] = await Promise.all([
			readFile(join(skillPath, SKILL_FILE), "utf8").catch(() => ""),
			readFile(join(skillPath, MARKER_FILE), "utf8").catch(() => ""),
		]);

		let marker: Marker | null = null;
		if (markerContent) {
			try {
				marker = JSON.parse(markerContent) as Marker;
			} catch {
				// Ignore malformed marker.
			}
		}

		let skillHash: string | null = null;
		if (skillContent) {
			skillHash = hashContent(skillContent);
		}

		return {
			exists: true,
			isSymlink: false,
			skillHash,
			marker,
			isDir: true,
		};
	} catch {
		// Path doesn't exist or access error.
		return {
			exists: false,
			isSymlink: false,
			isDir: false,
			skillHash: null,
			marker: null,
		};
	}
}

/**
 * Write SKILL.md to a directory with atomic semantics.
 *
 * Writes to a temp file then renames to avoid partial writes.
 */
export async function atomicWriteSkill(
	targetDir: string,
	content: string,
): Promise<void> {
	const tempPath = join(targetDir, `.${SKILL_FILE}.tmp`);
	const targetPath = join(targetDir, SKILL_FILE);

	await writeFile(tempPath, content, "utf8");
	await rename(tempPath, targetPath);
}

/**
 * Write the management marker into a skill directory.
 */
export async function writeMarker(targetDir: string, skillHash: string): Promise<void> {
	const markerPath = join(targetDir, MARKER_FILE);
	const marker = {
		managedBy: "pi-mempalace",
		skillHash,
		syncedAt: new Date().toISOString(),
	};
	await writeFile(markerPath, JSON.stringify(marker, null, 2), "utf8");
}

/**
 * Install a skill from scratch (real directory, not symlink).
 */
export async function installSkill(
	skillName: string,
	content: string,
	skillHash: string,
	baseDir: string = DEFAULT_AGENT_SKILLS_DIR,
): Promise<void> {
	const targetDir = join(baseDir, skillName);
	await mkdir(targetDir, { recursive: true });
	await atomicWriteSkill(targetDir, content);
	await writeMarker(targetDir, skillHash);
}

/**
 * Replace a symlink with a real directory (takes ownership from npx skills).
 *
 * Removes the symlink only — never follows or deletes its target.
 */
export async function replaceSymlinkWithDir(
	skillName: string,
	content: string,
	skillHash: string,
	baseDir: string = DEFAULT_AGENT_SKILLS_DIR,
): Promise<void> {
	const skillPath = join(baseDir, skillName);

	// Remove symlink only.
	await unlink(skillPath);

	// Install real directory.
	await installSkill(skillName, content, skillHash, baseDir);
}

/**
 * Replace a plain file (not symlink, not dir) with a real directory.
 *
 * Happens when something mistakenly wrote a file at the skill path.
 * Unlinks the file, then installs the directory.
 */
export async function replaceFileWithDir(
	skillName: string,
	content: string,
	skillHash: string,
	baseDir: string = DEFAULT_AGENT_SKILLS_DIR,
): Promise<void> {
	const skillPath = join(baseDir, skillName);

	// Remove the file.
	await unlink(skillPath);

	// Install real directory.
	await installSkill(skillName, content, skillHash, baseDir);
}

/**
 * Update an existing skill directory's content and marker.
 */
export async function updateSkill(
	skillName: string,
	content: string,
	skillHash: string,
	baseDir: string = DEFAULT_AGENT_SKILLS_DIR,
): Promise<void> {
	const targetDir = join(baseDir, skillName);
	await atomicWriteSkill(targetDir, content);
	await writeMarker(targetDir, skillHash);
}

/**
 * Rename helper (platform-agnostic).
 */
async function rename(from: string, to: string): Promise<void> {
	const { rename } = await import("node:fs/promises");
	await rename(from, to);
}