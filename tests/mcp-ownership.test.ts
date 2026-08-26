/**
 * Tests for MCP ownership + palace path resolution.
 *
 * Covers:
 * - resolvePersonalPalace: env → settings → default chain (Aug 8 backlog)
 * - planMcpRegistration: static-config precedence, binary/adapter skips, register shape
 * - resolveMempalaceConfig: override plumbing for the personal-default leg
 * - readConfiguredMcpServers: mcp.json parsing (string + object command forms)
 * - ensureMcpRegistration: injected adapter failures never throw, honest report
 *
 * All tests are tmpdir-based and hermetic — no network, no real adapter calls.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePersonalPalace } from "../domain/palace-default";
import { planMcpRegistration } from "../domain/mcp-registration";
import { resolveMempalaceConfig } from "../domain/palace-router";
import {
	readConfiguredMcpServers,
	ensureMcpRegistration,
	resolveBinary,
	type RegisterMcpServerFn,
	type McpRegistrationHandle,
} from "../infrastructure/mcp-ensurer";
import type { ConfiguredMcpServer } from "../domain/mcp-registration";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── resolvePersonalPalace ──────────────────────────────────────────────────────

test("env var wins over settings and default", () => {
	const r = resolvePersonalPalace(
		"/from/env/palace",
		"/from/settings/palace",
		"/home/user",
	);
	assert.equal(r.path, "/from/env/palace");
	assert.equal(r.source, "env");
});

test("whitespace-only env falls through to settings", () => {
	const r = resolvePersonalPalace("   \t  ", "/from/settings/palace", "/home/user");
	assert.equal(r.path, "/from/settings/palace");
	assert.equal(r.source, "settings");
});

test("settings wins when env absent, with ~/ expansion", () => {
	const r = resolvePersonalPalace(undefined, "~/palaces/mine", "/home/user");
	assert.equal(r.path, join("/home/user", "palaces/mine"));
	assert.equal(r.source, "settings");
});

test("bare ~ in settings resolves to home", () => {
	const r = resolvePersonalPalace(undefined, "~", "/home/user");
	assert.equal(r.path, "/home/user");
	assert.equal(r.source, "settings");
});

test("both absent → home-relative default, never a hardcoded absolute", () => {
	const fakeHome = join(tmpdir(), "fake-home-abc123");
	const r = resolvePersonalPalace(undefined, undefined, fakeHome);
	assert.equal(r.path, join(fakeHome, ".config", "mempalace", "palace"));
	assert.equal(r.source, "default");
	// Path must be derived from homeDir, not baked in.
	assert.ok(r.path.startsWith(fakeHome));
});

test("default tracks a different homeDir (no hardcoded path)", () => {
	const otherHome = join(tmpdir(), "other-home-xyz789");
	const r = resolvePersonalPalace(undefined, undefined, otherHome);
	assert.equal(r.path, join(otherHome, ".config", "mempalace", "palace"));
});

// ── planMcpRegistration ────────────────────────────────────────────────────────

const REGISTER_INPUTS = {
	configuredServers: [] as ConfiguredMcpServer[],
	binaryPath: "/usr/local/bin/mempalace-mcp",
	palace: "/resolved/palace",
	adapterAvailable: true,
	isPrintMode: false,
};

test("static config with name 'mempalace' takes precedence → skip", () => {
	const plan = planMcpRegistration({
		...REGISTER_INPUTS,
		configuredServers: [{ name: "mempalace", command: "mempalace-mcp" }],
	});
	assert.equal(plan.action, "skip");
	assert.equal(plan.reason, "already-configured");
});

test("static config with runtime name → skip", () => {
	const plan = planMcpRegistration({
		...REGISTER_INPUTS,
		configuredServers: [{ name: "pi-mempalace__mempalace" }],
	});
	assert.equal(plan.action, "skip");
	assert.equal(plan.reason, "already-configured");
});

test("static config whose command runs mempalace-mcp → skip", () => {
	const plan = planMcpRegistration({
		...REGISTER_INPUTS,
		configuredServers: [{ name: "totally-different", command: "mempalace-mcp" }],
	});
	assert.equal(plan.action, "skip");
	assert.equal(plan.reason, "already-configured");
});

test("unrelated configured servers do not block registration", () => {
	const plan = planMcpRegistration({
		...REGISTER_INPUTS,
		configuredServers: [
			{ name: "atlassian", command: undefined },
			{ name: "other", command: "some-other-binary" },
		],
	});
	assert.equal(plan.action, "register");
});

test("already-configured outranks adapter-unavailable (informative reason)", () => {
	const plan = planMcpRegistration({
		...REGISTER_INPUTS,
		adapterAvailable: false,
		configuredServers: [{ name: "mempalace", command: "mempalace-mcp" }],
	});
	assert.equal(plan.action, "skip");
	assert.equal(plan.reason, "already-configured");
});

test("no adapter → skip adapter-unavailable", () => {
	const plan = planMcpRegistration({ ...REGISTER_INPUTS, adapterAvailable: false });
	assert.equal(plan.action, "skip");
	assert.equal(plan.reason, "adapter-unavailable");
});

test("binary missing → skip binary-unreachable", () => {
	const plan = planMcpRegistration({ ...REGISTER_INPUTS, binaryPath: null });
	assert.equal(plan.action, "skip");
	assert.equal(plan.reason, "binary-unreachable");
});

test("print mode → skip before anything else", () => {
	const plan = planMcpRegistration({ ...REGISTER_INPUTS, isPrintMode: true });
	assert.equal(plan.action, "skip");
	assert.equal(plan.reason, "print-mode");
});

test("happy path → register with exact name, --palace arg, lazy lifecycle", () => {
	const plan = planMcpRegistration(REGISTER_INPUTS);
	assert.equal(plan.action, "register");
	if (plan.action !== "register") return;
	assert.equal(plan.name, "pi-mempalace__mempalace");
	assert.deepEqual(plan.definition.command, "/usr/local/bin/mempalace-mcp");
	assert.deepEqual(plan.definition.args, ["--palace", "/resolved/palace"]);
	assert.equal(plan.definition.lifecycle, "lazy");
	assert.deepEqual(plan.definition.directTools, [
		"mempalace_search",
		"mempalace_diary_write",
		"mempalace_diary_read",
		"mempalace_reconnect",
	]);
});

// ── resolveMempalaceConfig override plumbing ───────────────────────────────────

test("resolveMempalaceConfig honors settings override on the default leg", async () => {
	const dir = await mkdtemp(join(tmpdir(), "mempalace-router-"));
	const config = await resolveMempalaceConfig(dir, {
		envPalace: undefined,
		settingsPalace: "/from/settings/palace",
		homeDir: "/fake/home",
	});
	// No mempalace.yaml in tmpdir and not a CVP path → default leg = settings.
	assert.equal(config.palace, "/from/settings/palace");
});

test("resolveMempalaceConfig: mempalace.yaml palace_path still wins over env/settings", async () => {
	const dir = await mkdtemp(join(tmpdir(), "mempalace-router-"));
	await writeFile(
		join(dir, "mempalace.yaml"),
		"palace_path: /from/yaml/palace\n",
		"utf8",
	);
	const config = await resolveMempalaceConfig(dir, {
		envPalace: "/from/env/palace",
		settingsPalace: "/from/settings/palace",
		homeDir: "/fake/home",
	});
	assert.equal(config.palace, "/from/yaml/palace");
});

// ── readConfiguredMcpServers ───────────────────────────────────────────────────

test("parses mcp.json with string and object command forms", async () => {
	const dir = await mkdtemp(join(tmpdir(), "mcp-json-"));
	const file = join(dir, "mcp.json");
	await writeFile(
		file,
		JSON.stringify({
			mcpServers: {
				mempalace: { command: "mempalace-mcp", args: ["--palace", "/x"] },
				weird: { command: { command: "wrapped-binary" } },
			},
		}),
		"utf8",
	);
	const servers = await readConfiguredMcpServers([file]);
	assert.equal(servers.length, 2);
	const mempalace = servers.find((s) => s.name === "mempalace");
	assert.equal(mempalace?.command, "mempalace-mcp");
	const weird = servers.find((s) => s.name === "weird");
	assert.equal(weird?.command, "wrapped-binary");
});

test("missing file → empty list", async () => {
	const servers = await readConfiguredMcpServers([
		join(tmpdir(), "definitely-missing-mcp.json"),
	]);
	assert.deepEqual(servers, []);
});

test("malformed JSON → empty list", async () => {
	const dir = await mkdtemp(join(tmpdir(), "mcp-json-"));
	const file = join(dir, "mcp.json");
	await writeFile(file, "{ not valid json !!", "utf8");
	const servers = await readConfiguredMcpServers([file]);
	assert.deepEqual(servers, []);
});

// ── ensureMcpRegistration with injected deps ───────────────────────────────────

const fakePi = {} as ExtensionAPI;

/** Build an adapter-importer stub that records registerMcpServer calls. */
function stubImporter(handle: McpRegistrationHandle | Error) {
	const calls: Array<Parameters<RegisterMcpServerFn>[0]> = [];
	const fn = ((options: Parameters<RegisterMcpServerFn>[0]) => {
		if (handle instanceof Error) throw handle;
		calls.push(options);
		return handle;
	}) as RegisterMcpServerFn;
	return {
		importAdapter: () => Promise.resolve(fn),
		calls,
	};
}

test("adapter import failure → adapter-unavailable skip, no throw", async () => {
	const report = await ensureMcpRegistration(
		fakePi,
		"/tmp/anywhere",
		"interactive",
		"/resolved/palace",
		"env",
		{
			importAdapter: async () => null,
			readConfigured: async () => [],
			resolveBinaryFn: async () => "/usr/local/bin/mempalace-mcp",
		},
	);
	assert.equal(report.action.action, "skip");
	assert.equal(report.action.reason, "adapter-unavailable");
	assert.equal(report.registered, false);
	assert.equal(report.error, null);
	assert.equal(report.adapterAvailable, false);
});

test("successful registration → registered=true, register called with exact args", async () => {
	const handle: McpRegistrationHandle = {
		dispose: async () => {},
	};
	const stub = stubImporter(handle);
	const report = await ensureMcpRegistration(
		fakePi,
		"/tmp/anywhere",
		"interactive",
		"/resolved/palace",
		"default",
		{
			importAdapter: stub.importAdapter,
			readConfigured: async () => [],
			resolveBinaryFn: async () => "/usr/local/bin/mempalace-mcp",
		},
	);
	assert.equal(report.action.action, "register");
	assert.equal(report.registered, true);
	assert.equal(report.error, null);
	assert.equal(stub.calls.length, 1);
	assert.equal(stub.calls[0].name, "pi-mempalace__mempalace");
	assert.equal(stub.calls[0].definition.command, "/usr/local/bin/mempalace-mcp");
	assert.deepEqual(stub.calls[0].definition.args, ["--palace", "/resolved/palace"]);
});

test("registration throw → honest failure report, no throw", async () => {
	const report = await ensureMcpRegistration(
		fakePi,
		"/tmp/anywhere",
		"interactive",
		"/resolved/palace",
		"settings",
		{
			importAdapter: stubImporter(new Error("duplicate registration")).importAdapter,
			readConfigured: async () => [],
			resolveBinaryFn: async () => "/usr/local/bin/mempalace-mcp",
		},
	);
	assert.equal(report.action.action, "register");
	assert.equal(report.registered, false);
	assert.match(report.error ?? "", /duplicate registration/);
});

test("already-configured server → ensurer skips registration", async () => {
	const report = await ensureMcpRegistration(
		fakePi,
		"/tmp/anywhere",
		"interactive",
		"/resolved/palace",
		"default",
		{
			importAdapter: async () => (() => ({})) as never,
			readConfigured: async () => [
				{ name: "mempalace", command: "mempalace-mcp" },
			],
			resolveBinaryFn: async () => "/usr/local/bin/mempalace-mcp",
		},
	);
	assert.equal(report.action.action, "skip");
	assert.equal(report.action.reason, "already-configured");
	// importAdapter IS called to compute adapterAvailable, but registration
	// must not happen:
	assert.equal(report.registered, false);
});

// ── resolveBinary PATH splitting (regression: must split by ":" not "/") ─────

test("resolveBinary honors PATH list delimiter on POSIX", async () => {
	const dirA = await mkdtemp(join(tmpdir(), "resolvebin-a-"));
	const dirB = await mkdtemp(join(tmpdir(), "resolvebin-b-"));
	const binPath = join(dirB, "mempalace-mcp");
	await writeFile(binPath, "#!/bin/sh\nexit 0\n", "utf8");
	await chmod(binPath, 0o755);

	const oldPath = process.env.PATH;
	process.env.PATH = `${dirA}:${dirB}`;
	try {
		const found = await resolveBinary("mempalace-mcp");
		assert.equal(found, binPath);
	} finally {
		process.env.PATH = oldPath;
	}
});

test("resolveBinary returns null when binary absent from every PATH dir", async () => {
	const dirA = await mkdtemp(join(tmpdir(), "resolvebin-empty-"));
	const oldPath = process.env.PATH;
	process.env.PATH = dirA;
	try {
		assert.equal(await resolveBinary("definitely-not-a-real-binary-xyz"), null);
	} finally {
		process.env.PATH = oldPath;
	}
});
