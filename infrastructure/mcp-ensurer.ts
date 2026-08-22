/**
 * MCP server ensurer — runtime registration of mempalace-mcp via pi-mcp-adapter.
 *
 * Gathers observed state (configured servers, binary, adapter availability),
 * delegates the decision to the pure planner in domain/mcp-registration, and
 * executes registration when the plan says so. The palace path is resolved by
 * the application layer and passed in — this module never resolves it itself.
 *
 * All errors are caught and returned in the report — this never crashes
 * session_start and never writes any config file.
 */

import { access, constants, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
	ConfiguredMcpServer,
	McpRegistrationAction,
} from "../domain/mcp-registration";
import { planMcpRegistration } from "../domain/mcp-registration";

// ── Adapter types ──────────────────────────────────────────────────────────────

/** registerMcpServer signature from pi-mcp-adapter (type-only import). */
export type RegisterMcpServerFn =
	typeof import("pi-mcp-adapter")["registerMcpServer"];

/** Handle returned by registerMcpServer — dispose() to unregister. */
export type McpRegistrationHandle = Awaited<
	ReturnType<RegisterMcpServerFn>
>;

// ── Registration handle storage ────────────────────────────────────────────────

/**
 * Stored registration handle for the session. Held so the registration
 * survives garbage collection; currently not wired to disposal (registrations
 * are session-scoped and die with the process).
 */
let registrationHandle: McpRegistrationHandle | null = null;

// ── Configured servers detection ───────────────────────────────────────────────

/** mcp.json file shape (partial). */
interface McpJson {
	mcpServers?: Record<string, { command?: string | { command: string } }>;
}

/**
 * Read configured MCP servers from one or more mcp.json files.
 *
 * Handles both the stdio string form (`"command": "mempalace-mcp"`) and the
 * object form (`"command": { "command": "mempalace-mcp" }`). Missing or
 * malformed files are skipped silently.
 *
 * @param paths - Absolute paths to mcp.json files to check
 * @returns List of configured servers
 */
export async function readConfiguredMcpServers(
	paths: readonly string[],
): Promise<ConfiguredMcpServer[]> {
	const servers: ConfiguredMcpServer[] = [];

	for (const path of paths) {
		try {
			const content = await readFile(path, "utf8");
			const parsed = JSON.parse(content) as McpJson;

			for (const [name, server] of Object.entries(parsed.mcpServers ?? {})) {
				let command: string | undefined;
				if (typeof server.command === "string") {
					command = server.command;
				} else if (typeof server.command === "object" && server.command) {
					command = server.command.command;
				}

				servers.push({ name, command });
			}
		} catch {
			// File missing or malformed — skip
		}
	}

	return servers;
}

// ── Binary resolution ─────────────────────────────────────────────────────────

/**
 * Resolve a binary on PATH via manual search with an executability check.
 *
 * @param bin - Binary name (e.g., "mempalace-mcp")
 * @returns Absolute path if found and executable, else null
 */
export async function resolveBinary(bin: string): Promise<string | null> {
	const pathEnv = process.env.PATH;
	if (!pathEnv) return null;

	for (const dir of pathEnv.split(sep)) {
		const candidate = join(dir, bin);
		try {
			await access(candidate, constants.X_OK);
			return candidate;
		} catch {
			// Not executable or doesn't exist
		}
	}

	return null;
}

// ── Default adapter importer ───────────────────────────────────────────────────

/**
 * Dynamic import of pi-mcp-adapter with graceful failure. Returns null when
 * the adapter is not installed (e.g. pi runs without the pi-mcp-adapter
 * package).
 */
async function importRegisterMcpServer(): Promise<RegisterMcpServerFn | null> {
	try {
		const adapter = await import("pi-mcp-adapter");
		return adapter.registerMcpServer;
	} catch {
		return null;
	}
}

// ── Report ─────────────────────────────────────────────────────────────────────

/** Report from the MCP ensure operation. */
export interface McpEnsureReport {
	/** The plan produced by the pure planner. */
	readonly action: McpRegistrationAction;
	/** Final palace path (already resolved by the application layer). */
	readonly palacePath: string;
	/** Where the palace path came from (env / settings / default / router). */
	readonly palaceSource: string;
	/** Resolved binary path, or null when not on PATH. */
	readonly binaryPath: string | null;
	/** All servers observed from global + project mcp.json files. */
	readonly configuredServers: readonly ConfiguredMcpServer[];
	/** Whether pi-mcp-adapter could be imported. */
	readonly adapterAvailable: boolean;
	/** True only when registerMcpServer() actually succeeded this call. */
	readonly registered: boolean;
	/** Error message when registration was attempted and failed. */
	readonly error: string | null;
}

/** Injectable dependencies (defaults hit the real fs/env/adapter). */
export interface EnsureMcpDeps {
	readonly importAdapter?: () => Promise<RegisterMcpServerFn | null>;
	readonly readConfigured?: (
		paths: readonly string[],
	) => Promise<ConfiguredMcpServer[]>;
	readonly resolveBinaryFn?: (bin: string) => Promise<string | null>;
}

// ── Main ensurer ───────────────────────────────────────────────────────────────

/**
 * Ensure the mempalace-mcp server is registered with pi-mcp-adapter.
 *
 * Session-scoped and only-if-missing: when any config file already defines a
 * server named "mempalace" (or anything running the mempalace-mcp binary),
 * the static config wins and nothing is registered. Never throws, never
 * writes config files.
 *
 * @param pi - ExtensionAPI instance
 * @param cwd - Current working directory (for project-level mcp.json lookup)
 * @param mode - Session mode ("print" skips registration)
 * @param palacePath - Fully resolved palace path for the --palace arg
 * @param palaceSource - Human-readable source of palacePath (for status)
 * @param deps - Optional dependency injection for tests
 * @returns Report with the action taken and observed context
 */
export async function ensureMcpRegistration(
	pi: ExtensionAPI,
	cwd: string,
	mode: string,
	palacePath: string,
	palaceSource: string,
	deps: EnsureMcpDeps = {},
): Promise<McpEnsureReport> {
	const importAdapter = deps.importAdapter ?? importRegisterMcpServer;
	const readConfigured =
		deps.readConfigured ?? readConfiguredMcpServers;
	const resolveBinaryFn = deps.resolveBinaryFn ?? resolveBinary;

	// 1. Observed state
	const globalMcp = join(homedir(), ".pi", "agent", "mcp.json");
	const configuredServers = await readConfigured([
		globalMcp,
		join(cwd, ".mcp.json"),
		join(cwd, ".pi", "mcp.json"),
	]);
	const binaryPath = await resolveBinaryFn("mempalace-mcp");
	const registerFn = await importAdapter();
	const adapterAvailable = registerFn !== null;

	// 2. Plan (pure)
	const plan = planMcpRegistration({
		configuredServers,
		binaryPath,
		palace: palacePath,
		adapterAvailable,
		isPrintMode: mode === "print",
	});

	// 3. Execute only when the plan says register
	let registered = false;
	let error: string | null = null;
	if (plan.action === "register" && registerFn) {
		try {
			registrationHandle = registerFn({
				pi,
				name: plan.name,
				definition: plan.definition,
			});
			registered = true;
		} catch (e) {
			// Duplicate name, adapter state issue, etc. — report, never throw.
			error = e instanceof Error ? e.message : String(e);
		}
	}

	return {
		action: plan,
		palacePath,
		palaceSource,
		binaryPath,
		configuredServers,
		adapterAvailable,
		registered,
		error,
	};
}
