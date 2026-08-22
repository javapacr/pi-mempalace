/**
 * MCP ownership use case — orchestrates palace resolution and MCP registration.
 *
 * Mirrors the skill-sync usecase pattern: thin orchestration that resolves the
 * palace path once via the full router chain (mempalace.yaml → CVP heuristic →
 * env → settings → home-relative default), then delegates registration to the
 * infrastructure ensurer.
 */

import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { McpEnsureReport } from "../infrastructure/mcp-ensurer";
import { ensureMcpRegistration, type EnsureMcpDeps } from "../infrastructure/mcp-ensurer";
import { resolveMempalaceConfig } from "../domain/palace-router";
import { resolvePersonalPalace } from "../domain/palace-default";
import { readMempalaceSettings } from "../infrastructure/settings-reader";

/**
 * Ensure mempalace-mcp is registered (session-scoped, only-if-missing).
 *
 * Resolves the palace via the full router chain and passes it to the ensurer —
 * the palace is resolved exactly once per invocation. When mempalace.yaml or
 * the CVP heuristic overrides the personal default, the report's source says
 * so instead of env/settings/default.
 *
 * @param pi - ExtensionAPI instance
 * @param cwd - Current working directory
 * @param mode - Session mode (skip registration in "print" mode)
 * @param deps - Optional dependency injection for tests
 * @returns Report with registration action and context
 */
export async function ensureMcp(
	pi: ExtensionAPI,
	cwd: string,
	mode: string,
	deps: EnsureMcpDeps = {},
): Promise<McpEnsureReport> {
	// Personal default chain (env → settings → home-relative) for the source label.
	const personal = resolvePersonalPalace(
		process.env.MEMPALACE_PALACE,
		(await readMempalaceSettings()).palace,
		homedir(),
	);

	// Full router: mempalace.yaml > CVP heuristic > personal default.
	// (The router applies the same env/settings chain internally.)
	const config = await resolveMempalaceConfig(cwd);

	const palaceSource =
		config.palace === personal.path
			? personal.source
			: "router (mempalace.yaml/CVP override)";

	return ensureMcpRegistration(
		pi,
		cwd,
		mode,
		config.palace,
		palaceSource,
		deps,
	);
}
