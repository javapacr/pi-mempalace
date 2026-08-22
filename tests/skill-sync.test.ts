/**
 * Tests for MemPalace skill sync functionality.
 */

import { mkdir, rm, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, beforeEach, afterEach } from "node:test";
import { hashContent, buildSkillPlan, parseMarker, type Marker, MARKER_FILE } from "../domain/skill-sync";
import { readSkillDirState, atomicWriteSkill, writeMarker, installSkill, replaceSymlinkWithDir, updateSkill } from "../infrastructure/skill-installer";

const TEST_SKILLS_BASE = join(tmpdir(), "test-pi-mempalace-skills");
const SKILL_FILE = "SKILL.md";

describe("domain/skill-sync", () => {
	describe("hashContent", () => {
		it("computes consistent SHA-256 hashes", () => {
			const content = "hello world";
			const h1 = hashContent(content);
			const h2 = hashContent(content);
			if (h1 !== h2) throw new Error("Hashes should be equal");
			if (h1.length !== 64) throw new Error("SHA-256 hash should be 64 chars");
		});

		it("different content produces different hashes", () => {
			const h1 = hashContent("foo");
			const h2 = hashContent("bar");
			if (h1 === h2) throw new Error("Different content should produce different hashes");
		});
	});

	describe("parseMarker", () => {
		it("parses valid JSON", () => {
			const content = JSON.stringify({
				managedBy: "pi-mempalace",
				skillHash: "abc123",
				syncedAt: "2024-01-01T00:00:00Z",
			});
			const marker = parseMarker(content);
			if (!marker || marker.managedBy !== "pi-mempalace" || marker.skillHash !== "abc123") {
				throw new Error("Failed to parse valid marker");
			}
		});

		it("returns null for invalid JSON", () => {
			if (parseMarker("not json") !== null) throw new Error("Should return null for invalid JSON");
			if (parseMarker("") !== null) throw new Error("Should return null for empty string");
		});
	});

	describe("buildSkillPlan", () => {
		it("plans INSTALL when directory doesn't exist", () => {
			const plan = buildSkillPlan("test-skill", "content", {
				exists: false,
				isSymlink: false,
				skillHash: null,
				marker: null,
			});
			if (plan.action !== "INSTALL") throw new Error("Should plan INSTALL");
			if (plan.reason !== "Directory does not exist") throw new Error("Wrong reason");
		});

		it("plans REPLACE_SYMLINK for symlink", () => {
			const plan = buildSkillPlan("test-skill", "new content", {
				exists: true,
				isSymlink: true,
				skillHash: null,
				marker: null,
			});
			if (plan.action !== "REPLACE_SYMLINK") throw new Error("Should plan REPLACE_SYMLINK");
			if (!plan.reason.includes("symlink")) throw new Error("Reason should mention symlink");
		});

		it("plans NOOP when current and managed", () => {
			const bundledHash = hashContent("content");
			const plan = buildSkillPlan("test-skill", "content", {
				exists: true,
				isSymlink: false,
				skillHash: bundledHash,
				marker: {
					managedBy: "pi-mempalace",
					skillHash: bundledHash,
					syncedAt: "2024-01-01T00:00:00Z",
				},
			});
			if (plan.action !== "NOOP") throw new Error("Should plan NOOP");
		});

		it("plans UPDATE when hash differs", () => {
			const plan = buildSkillPlan("test-skill", "new content", {
				exists: true,
				isSymlink: false,
				skillHash: hashContent("old content"),
				marker: {
					managedBy: "pi-mempalace",
					skillHash: hashContent("old content"),
					syncedAt: "2024-01-01T00:00:00Z",
				},
			});
			if (plan.action !== "UPDATE") throw new Error("Should plan UPDATE");
			if (!plan.reason.includes("differs")) throw new Error("Reason should mention hash difference");
		});
	});
});

describe("infrastructure/skill-installer (with tempdir)", () => {
	let baseDir: string;

	beforeEach(async () => {
		baseDir = join(TEST_SKILLS_BASE, Date.now().toString());
		await mkdir(baseDir, { recursive: true });
	});

	afterEach(async () => {
		await rm(TEST_SKILLS_BASE, { recursive: true, force: true }).catch(() => {});
	});

	async function setupMockEnv(skillName: string): Promise<string> {
		const skillDir = join(baseDir, skillName);
		return skillDir;
	}

	it("installs a skill directory with SKILL.md and marker", async () => {
		const skillDir = await setupMockEnv("test-install");
		const content = "# Test Skill";
		const skillHash = hashContent(content);

		await installSkill("test-install", content, skillHash, baseDir);

		const installedContent = await readFile(join(skillDir, SKILL_FILE));
		if (installedContent !== content) throw new Error("Skill content mismatch");

		const markerContent = await readFile(join(skillDir, MARKER_FILE));
		const marker = JSON.parse(markerContent) as Marker;
		if (marker.managedBy !== "pi-mempalace" || marker.skillHash !== skillHash) {
			throw new Error("Marker mismatch");
		}
	});

	it("replaces a symlink with a real directory", async () => {
		const skillDir = await setupMockEnv("test-replace");
		const decoyDir = join(baseDir, "decoy");
		await mkdir(decoyDir, { recursive: true });
		await symlink(decoyDir, skillDir);

		const content = "# Replaced Skill";
		const skillHash = hashContent(content);

		await replaceSymlinkWithDir("test-replace", content, skillHash, baseDir);

		const stat = await lstat(skillDir);
		if (stat.isSymbolicLink()) throw new Error("Should not be a symlink");
		if (!stat.isDirectory()) throw new Error("Should be a directory");

		const installedContent = await readFile(join(skillDir, SKILL_FILE));
		if (installedContent !== content) throw new Error("Content mismatch after replace");

		// Decoy directory should still exist and be untouched.
		const decoyContent = await readFile(join(decoyDir, SKILL_FILE)).catch(() => "");
		if (decoyContent !== "") throw new Error("Decoy should be untouched");
	});

	it("updates an existing skill directory", async () => {
		const skillDir = await setupMockEnv("test-update");
		await mkdir(skillDir, { recursive: true });
		const oldContent = "# Old Skill";
		const oldHash = hashContent(oldContent);
		await writeFile(join(skillDir, SKILL_FILE), oldContent);

		const newContent = "# New Skill";
		const newHash = hashContent(newContent);

		await updateSkill("test-update", newContent, newHash, baseDir);

		const installedContent = await readFile(join(skillDir, SKILL_FILE));
		if (installedContent !== newContent) throw new Error("Content should be updated");

		const markerContent = await readFile(join(skillDir, MARKER_FILE));
		const marker = JSON.parse(markerContent) as Marker;
		if (marker.skillHash !== newHash) throw new Error("Marker hash should be updated");
	});
});

// Helper to read file with fallback
async function readFile(path: string): Promise<string> {
	const { readFile: read } = await import("node:fs/promises");
	return read(path, "utf8");
}

async function lstat(path: string): Promise<{ isSymbolicLink: () => boolean; isDirectory: () => boolean }> {
	const { lstat } = await import("node:fs/promises");
	const stat = await lstat(path);
	return {
		isSymbolicLink: () => stat.isSymbolicLink(),
		isDirectory: () => stat.isDirectory(),
	};
}