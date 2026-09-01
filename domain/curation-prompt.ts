/**
 * Curation prompt builder — pure function.
 *
 * Builds the in-session curation checkpoint message used for periodic LLM curation.
 * No side-effects, no I/O, no pi dependencies. The optional `repoWingHint` is
 * resolved by the caller (best-effort git repo name from the session cwd);
 * the builder stays pure and only interpolates it.
 */

import type { MempalaceConfig } from "./types";

export function buildCurationPrompt(
	config: MempalaceConfig,
	exchangeCount: number,
	repoWingHint?: string,
): string {
	const repoHintLine = repoWingHint
		? `Likely repo wing: ${repoWingHint}\n`
		: "";
	const agentWingClause = config.wing ? ` (e.g. ${config.wing})` : "";
	return (
		`[MemPalace checkpoint — ${exchangeCount} exchanges]\n` +
		`Curate this session yourself, now — do NOT dispatch a subagent. Use the active profile's MemPalace MCP server ` +
		`(\`mcp({ tool: "mempalace_mempalace_<action>", args: "..." })\`) to file ` +
		`up to 3 key items from this session into the palace at:\n` +
		`  ${config.palace}\n` +
		`Target wing: if this session's work is anchored in a long-lived repo (an anchor repo you return to and mine), ` +
		`file to that repo's wing — match the existing wing name (e.g. pi-mempalace-github, pi-extensions).\n` +
		repoHintLine +
		`Personal or cross-repo items go to your agent wing${agentWingClause}. ` +
		`The sessions wing is for mined transcripts, not diaries.\n\n` +
		`Required workflow:\n` +
		`1. Before adding any drawer, call \`mempalace_mempalace_check_duplicate\` ` +
		`   to avoid duplicates.\n` +
		`2. Call \`mempalace_mempalace_add_drawer\` for verbatim quotes or key decisions.\n` +
		`3. Call \`mempalace_mempalace_kg_add\` for entity relationships discovered.\n` +
		`4. Call \`mempalace_mempalace_diary_write\` for a brief AAAK summary.\n` +
		`5. If useful, call \`mempalace_mempalace_add_tunnel\` to connect related concepts.\n\n` +
		`File at most 3 items. Be concise and verbatim. ` +
		`Reply with: CURATION COMPLETE when done.`
	);
}
