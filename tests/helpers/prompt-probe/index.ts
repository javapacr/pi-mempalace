/**
 * Prompt-probe test extension (PRD §4 AC-A1/A3/A4).
 *
 * Registered LAST in a scratch PI_CODING_AGENT_DIR alongside the extension
 * under test. Hooks `before_agent_start` and appends one JSONL line per
 * event to `$PROMPT_PROBE_DIR/probe.jsonl`:
 *
 *   { ts, turn, sha256, length, mempalaceMarker, task }
 *
 * PII discipline (security F6, PRD §9): writes HASH + LENGTH + marker FLAG
 * only — never the raw system prompt. `task` records the first 80 chars of
 * the prompt purely to prove sibling tasks differ; it is the task string
 * the test itself passed, not user data.
 */

import { appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type {
	ExtensionAPI,
	BeforeAgentStartEvent,
} from "@earendil-works/pi-coding-agent";

let turnCount = 0;

export default function promptProbeExtension(pi: ExtensionAPI): void {
	pi.on("before_agent_start", (event: BeforeAgentStartEvent) => {
		turnCount += 1;
		const dir = process.env.PROMPT_PROBE_DIR;
		if (!dir) return;

		const systemPrompt = event.systemPrompt ?? "";
		const prompt = event.prompt ?? "";

		appendFileSync(
			join(dir, "probe.jsonl"),
			JSON.stringify({
				ts: new Date().toISOString(),
				turn: turnCount,
				sha256: createHash("sha256").update(systemPrompt).digest("hex"),
				length: Buffer.byteLength(systemPrompt),
				mempalaceMarker: systemPrompt.includes("[MemPalace Session Context]"),
				task: prompt.slice(0, 80),
			}) + "\n",
		);
	});
}
