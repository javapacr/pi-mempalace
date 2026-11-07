/**
 * Transcript probe — synchronous, early-exit read of a pi session JSONL to
 * decide whether MemPalace would parse it as a conversation (see
 * domain/pi-transcript.ts). Synchronous on purpose: the shutdown mine path is
 * fully synchronous so no pending promise holds process exit.
 *
 * Reads in 64 KiB chunks and stops once the verdict is known; most sessions
 * settle it within the first chunk. Unreadable file → true (mine anyway):
 * the guard exists to skip a known raw-JSON fallback, not to hide errors,
 * and `mempalace mine` reports a missing file itself.
 */

import { closeSync, openSync, readSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { TranscriptMinability } from "../domain/pi-transcript";

const CHUNK_BYTES = 64 * 1024;

export function isMinableTranscript(filePath: string): boolean {
	let fd: number;
	try {
		fd = openSync(filePath, "r");
	} catch {
		return true;
	}
	const judge = new TranscriptMinability();
	try {
		const buf = Buffer.alloc(CHUNK_BYTES);
		// The decoder holds back a multibyte character split across chunks.
		const decoder = new StringDecoder("utf8");
		let carry = "";
		for (;;) {
			const n = readSync(fd, buf, 0, CHUNK_BYTES, null);
			if (n <= 0) break;
			const lines = (carry + decoder.write(buf.subarray(0, n))).split("\n");
			carry = lines.pop() ?? "";
			for (const line of lines) {
				judge.feed(line);
				if (judge.done) return true;
			}
		}
		judge.feed(carry + decoder.end());
		return judge.minable;
	} catch {
		return true;
	} finally {
		closeSync(fd);
	}
}
