/**
 * Recall renderer — registers the TUI badge for MemPalace recall messages.
 *
 * Displays: ◆ MemPalace  N memor(y|ies) recalled [wing: X] [palace: Y]
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { RECALL_CUSTOM_TYPE } from "../domain/types";

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
