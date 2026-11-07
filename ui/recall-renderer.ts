/**
 * MemPalace message renderers — TUI badges for the recall and wake-up messages.
 *
 * Recall:  ◆ MemPalace  N memor(y|ies) recalled [wing: X] [palace: Y]
 * Wake-up: ◆ MemPalace  wake-up context loaded (~N tokens)
 *
 * Badges only: the full text still reaches the model; the TUI shows one line.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { RECALL_CUSTOM_TYPE } from "../domain/types";
import { WAKEUP_CUSTOM_TYPE } from "../domain/wake-up-message";

export function registerWakeUpRenderer(pi: ExtensionAPI): void {
	pi.registerMessageRenderer(WAKEUP_CUSTOM_TYPE, (message, _options, theme) => {
		const text =
			typeof message.content === "string"
				? message.content
				: message.content
						.map((b) => (b.type === "text" ? b.text : ""))
						.join("");
		// ~4 characters per token — a display estimate, not a tokenizer count.
		const tokens = Math.round(text.length / 4);
		return new Text(
			theme.fg("accent", "◆ MemPalace ") +
				theme.fg("muted", `wake-up context loaded (~${tokens} tokens)`),
			0,
			0,
		);
	});
}

export function registerRecallRenderer(pi: ExtensionAPI): void {
	pi.registerMessageRenderer(RECALL_CUSTOM_TYPE, (message, _options, theme) => {
		const details = message.details as
			| { count: number; wing: string | null; palace: string }
			| undefined;
		const count = details?.count ?? 0;
		const wingLabel = details?.wing
			? theme.fg("dim", ` [wing: ${details.wing}]`)
			: "";
		const palaceLabel = details?.palace
			? theme.fg("dim", ` [palace: ${details.palace}]`)
			: "";

		const prefix = theme.fg("accent", "◆ MemPalace ");
		const body =
			theme.fg("muted", `${count} memor${count === 1 ? "y" : "ies"} recalled`) +
			wingLabel +
			palaceLabel;

		return new Text(prefix + body, 0, 0);
	});
}
