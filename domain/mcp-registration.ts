/**
 * MCP server registration planning — pure state machine.
 *
 * Decides whether to register the mempalace-mcp server at runtime.
 * The planner never performs I/O or registration itself — it only
 * returns a plan based on observed state.
 */

/**
 * A configured MCP server as observed from config files.
 */
export interface ConfiguredMcpServer {
	readonly name: string;
	readonly command?: string;
}

/**
 * Registration action to take.
 */
export type McpRegistrationAction =
	| { action: "skip"; reason: "already-configured" }
	| { action: "skip"; reason: "binary-unreachable" }
	| { action: "skip"; reason: "adapter-unavailable" }
	| { action: "skip"; reason: "print-mode" }
	| {
			action: "register";
			name: string;
			definition: {
				readonly command: string;
				readonly args: readonly string[];
				readonly lifecycle: "lazy";
				readonly directTools: readonly string[];
			};
	  };

/**
 * Plan MCP server registration.
 *
 * @param configuredServers - All servers observed from global + project mcp.json files
 * @param binaryPath - Resolved path to mempalace-mcp binary, or null if not on PATH
 * @param palace - The palace path to pass via --palace arg
 * @param adapterAvailable - Whether pi-mcp-adapter was successfully imported
 * @param isPrintMode - Whether the current session is in print mode (skip registration)
 * @returns Registration plan
 */
export function planMcpRegistration({
	configuredServers,
	binaryPath,
	palace,
	adapterAvailable,
	isPrintMode,
}: {
	configuredServers: readonly ConfiguredMcpServer[];
	binaryPath: string | null;
	palace: string;
	adapterAvailable: boolean;
	isPrintMode: boolean;
}): McpRegistrationAction {
	// Print mode: skip entirely (subprocess)
	if (isPrintMode) {
		return { action: "skip", reason: "print-mode" };
	}

	// Check for existing configuration — static config takes precedence over
	// everything else, so this is checked before adapter/binary availability
	// ("already-configured" is the most informative reason when it applies).
	for (const server of configuredServers) {
		// Name match: "mempalace" or our runtime name
		if (server.name === "mempalace" || server.name === "pi-mempalace__mempalace") {
			return { action: "skip", reason: "already-configured" };
		}

		// Command match: any server using the mempalace-mcp binary
		if (server.command?.includes("mempalace-mcp")) {
			return { action: "skip", reason: "already-configured" };
		}
	}

	// Adapter not installed: cannot register
	if (!adapterAvailable) {
		return { action: "skip", reason: "adapter-unavailable" };
	}

	// Binary not on PATH: cannot register
	if (!binaryPath) {
		return { action: "skip", reason: "binary-unreachable" };
	}

	// Register with the runtime name and resolved palace. directTools mirrors
	// the four first-class tools from the former static mcp.json entries so the
	// gateway keeps offering them as native tools (adapter supports per-server
	// directTools on the definition).
	return {
		action: "register",
		name: "pi-mempalace__mempalace",
		definition: {
			command: "mempalace-mcp",
			args: ["--palace", palace],
			lifecycle: "lazy",
			directTools: [
				"mempalace_search",
				"mempalace_diary_write",
				"mempalace_diary_read",
				"mempalace_reconnect",
			],
		},
	};
}
