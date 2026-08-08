/**
 * Curation prompt builder — pure function.
 *
 * Builds the worker subagent task string used for periodic LLM curation.
 * No side-effects, no I/O, no pi dependencies.
 */

import type { MempalaceConfig } from "./types";

export function buildCurationPrompt(
	config: MempalaceConfig,
	exchangeCount: number,
): string {
	return (
		`[MemPalace checkpoint — ${exchangeCount} exchanges]\n` +
		`You are a curation worker. Use the active profile's MemPalace MCP server ` +
		`(\`mcp({ tool: "mempalace_mempalace_<action>", args: "..." })\`) to file ` +
		`up to 3 key items from this session into the palace at:\n` +
		`  ${config.palace}\n` +
		`Target wing: ${config.wing ?? "sessions"}\n\n` +
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
