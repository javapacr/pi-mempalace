/**
 * Prompt-probe test extension (PRD §4 AC-A1/A3/A4).
 *
 * Registered LAST in a scratch PI_CODING_AGENT_DIR alongside the extension
 * under test. Hooks `before_agent_start` and appends one JSONL line per
 * event to `$PROMPT_PROBE_DIR/probe.jsonl`:
 *
 *   { ts, turn, sha256, length, mempalaceMarker, task }
 *
 * `event.systemPrompt` is a live getter in pi >= 0.86, so a probe registered
 * last sees sections set by earlier handlers.
 *
 * It also hooks `context` (fired before each LLM call with the run's
 * messages) and appends one line per call to `$PROMPT_PROBE_DIR/context.jsonl`:
 *
 *   { ts, wakeUpMessages, wakeUpSha256 }
 *
 * — the count of `mempalace-wakeup` custom messages in the context: the
 * wake-up travels as a conversation message, never a prompt section.
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
	pi.on("context", (event) => {
		const dir = process.env.PROMPT_PROBE_DIR;
		if (!dir) return;
		const wakeUps = event.messages.filter(
			(m) =>
				(m as { role?: string }).role === "custom" &&
				(m as { customType?: string }).customType === "mempalace-wakeup",
		);
		// Hash only — the wake-up text is palace content (PII discipline).
		const wakeUpSha256 = createHash("sha256")
			.update(JSON.stringify(wakeUps.map((m) => (m as { content?: unknown }).content)))
			.digest("hex");
		appendFileSync(
			join(dir, "context.jsonl"),
			JSON.stringify({
				ts: new Date().toISOString(),
				wakeUpMessages: wakeUps.length,
				wakeUpSha256,
			}) + "\n",
		);
	});

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
				// `<mempalace>` = prompt-section injection (pi >= 0.86); the legacy
				// header still marks the pre-change worktree in the A/B comparison.
				mempalaceMarker:
					systemPrompt.includes("<mempalace>\n") ||
					systemPrompt.includes("[MemPalace Session Context]"),
				task: prompt.slice(0, 80),
			}) + "\n",
		);
	});
}
