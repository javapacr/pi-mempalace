/**
 * Type-only shim for the pi-mcp-adapter runtime registration API.
 *
 * The real package ships raw TypeScript sources (built for Pi's source-loader)
 * with .ts-extension imports, which plain `tsc --noEmit` cannot follow without
 * allowImportingTsExtensions. tsconfig `paths` maps the module specifier to
 * this shim for typechecking only — at runtime, Pi resolves the installed
 * npm:pi-mcp-adapter package (see package.json peerDependencies) and the
 * dynamic import in infrastructure/mcp-ensurer.ts hits the real module.
 *
 * Keep this in sync with pi-mcp-adapter's index.ts (registerMcpServer,
 * McpServerRegistration, ServerEntry).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Handle returned by registerMcpServer — dispose() to unregister. */
export interface McpServerRegistration {
	dispose(): Promise<void>;
}

/** Server definition (subset used by this extension). */
export interface ServerEntry {
	command?: string;
	args?: readonly string[];
	cwd?: string;
	env?: Record<string, string>;
	url?: string;
	lifecycle?: "lazy" | "eager";
}

/**
 * Register an MCP server with the adapter installed for the given Pi
 * instance. Session-scoped, never written to config files; fails closed on
 * duplicate names. Throws when no adapter is installed.
 */
export function registerMcpServer(options: {
	pi: ExtensionAPI;
	name: string;
	definition: ServerEntry;
}): McpServerRegistration;
