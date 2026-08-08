/**
 * Recall parser — pure function that extracts scored snippets from raw
 * `mempalace search` CLI output.
 *
 * No side-effects, no I/O, no pi dependencies.
 */

/**
 * Parse raw `mempalace search` output into an array of text snippets,
 * keeping only blocks whose cosine similarity meets the threshold.
 */
/**
 * Format recall snippets into an LLM-facing context block.
 *
 * Frames the content explicitly as fuzzy long-term memory so the model
 * knows to treat it with appropriate skepticism: it may be directly
 * relevant, tangentially related, or entirely unrelated to the current
 * prompt. The model should use only what genuinely applies and never
 * force a connection.
 */
export function formatRecallContext(snippets: string[]): string {
	return (
		`[MemPalace Memory Recall]\n` +
		`The following were retrieved from long-term memory based on semantic similarity to the current prompt. ` +
		`Treat this as fuzzy memory — it may be directly relevant, tangentially related, or not relevant at all. ` +
		`Do not force connections; use only what genuinely applies.\n\n` +
		snippets.join("\n---\n")
	);
}

export function parseSearchSnippets(
	raw: string,
	threshold: number,
	maxSnippetLen: number,
): string[] {
	// Output blocks are separated by horizontal rules (─────)
	const blocks = raw.split(/─{10,}/);
	const snippets: string[] = [];

	for (const block of blocks) {
		// Match both `cosine=` (older CLI) and `cosine_sim=` (newer CLI)
		const scoreMatch = block.match(/cosine(?:_sim)?=([0-9.]+)/);
		if (!scoreMatch || parseFloat(scoreMatch[1]) < threshold) continue;

		// Extract the indented content paragraph
		const contentMatch = block.match(/\n\n\s+(.+?)(?:\n\s+─|\s*$)/s);
		if (!contentMatch) continue;

		const snippet = contentMatch[1].trim().slice(0, maxSnippetLen);
		if (snippet) snippets.push(snippet);
	}

	return snippets;
}
