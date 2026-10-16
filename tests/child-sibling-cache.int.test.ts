/**
 * Integration: real pi children + prompt-probe harness (PRD §4 ACs).
 *
 * Spawns REAL `pi --print` processes against a scratch PI_CODING_AGENT_DIR
 * (provider + session storage only). Extension loading is hermetic —
 * `--no-extensions --extension <under-test> --extension <probe>` — mirroring
 * the pi-subagents canonical child invocation; flag order = registration
 * order, so the probe is registered LAST. The probe writes sha256 + length
 * + marker flag per before_agent_start event — never the raw prompt (PII
 * discipline, §9).
 *
 * Coverage:
 *  - AC-A1: two real sibling children → identical system-prompt hashes, no
 *    [MemPalace Session Context], tasks differ.
 *  - AC-A4: child + PI_MEMPALACE_CHILD_WAKEUP=1 → marker present (also the
 *    non-vacuity control); + csv scoping vs PI_SUBAGENT_CHILD_AGENT → absent.
 *  - AC-A3: parent (no child env) prompt hash identical pre/post change.
 *    The pre-change tree is PI_MEMPALACE_PRE_CHANGE_DIR when set; otherwise
 *    it is materialised with `git archive` from PI_MEMPALACE_PRE_CHANGE_REF
 *    (default: the merge-base of HEAD with origin/main), so a branch must
 *    not change the parent's system prompt.
 *  - AC-A6: fork-style children stable across curation-style spawns, plus
 *    the PI_SUBAGENT_CHILD upstream-contract pin against the installed
 *    pi-subagents package (PI_SUBAGENTS_PKG_DIR, else the profile's and the
 *    shared git install, else the npm install).
 *
 * The pi binary is PI_MEMPALACE_INT_PI_BIN when set, else the first `pi` on
 * PATH outside any node_modules/.bin — npm and npx prepend the repo's own
 * .bin, whose `pi` is the locked dev dependency, not the installed runtime.
 * Every spawn drops the host's PI_* / JITI_* variables: a pi-subagents
 * runner exports PI_PACKAGE_DIR (its own pi's package root) and JITI_ALIAS,
 * and a different pi version reading another version's theme files crashes
 * in initTheme before before_agent_start (W3.R4).
 *
 * Skips (with explicit reason) when prerequisites are absent so the repo
 * stays hermetic on machines without pi / pi-subagents / git. Print mode is
 * used throughout: children reach wake-up exactly
 * through the before_agent_start self-heal (PRD §7.3), which the gate must
 * close; the session_start body surface is unit-pinned in child-gate.test.ts.
 */

import { spawn, execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

const __dirname = dirname(fileURLToPath(import.meta.url));
// This file lives at <repo>/tests/ — ONE level up is the repo root.
const REPO_ROOT = join(__dirname, "..");
const PRE_CHANGE_DIR_ENV = process.env.PI_MEMPALACE_PRE_CHANGE_DIR;

/** First existing pi-subagents package dir: the env override (only it when
 *  set), else the profile git install, the shared git install, then npm. */
function resolveSubagentsPkg(): string {
	if (process.env.PI_SUBAGENTS_PKG_DIR) return process.env.PI_SUBAGENTS_PKG_DIR;
	const home = homedir();
	const gitRel = join("git", "github.com", "nicobailon", "pi-subagents");
	const candidates = [
		...(process.env.PI_CODING_AGENT_DIR ? [join(process.env.PI_CODING_AGENT_DIR, gitRel)] : []),
		join(home, ".pi", "agent", gitRel),
		join(home, ".pi", "agent", "npm", "node_modules", "pi-subagents"),
	];
	return candidates.find((c) => existsSync(c)) ?? candidates[candidates.length - 1];
}
const PI_SUBAGENTS_PKG = resolveSubagentsPkg();

/** Scratch base — must be /tmp, NOT os.tmpdir(): on macOS that is
 *  /var/folders/…, which the pi project sandbox does not allow-write, and
 *  spawned pi processes hang writing session state there. The dress
 *  rehearsal with a /tmp scratch worked end-to-end. */
const TMP_BASE = process.env.PI_MEMPALACE_INT_TMP ?? "/tmp";

/** Scrubbed then re-set per spawn: every PI_* and JITI_* variable (the
 *  runner's gate vars, since it may itself run inside a pi subagent child;
 *  its session coupling; and a runner's PI_PACKAGE_DIR / JITI_ALIAS, W3.R4),
 *  every MEMPALACE_* variable (MEMPALACE_PALACE_PATH / MEMPALACE_BACKEND
 *  would route the spawn's CLI subprocess at the runner's REAL palace;
 *  MEMPALACE_PALACE is re-set to the scratch palace), and pi-subagents'
 *  MCP_DIRECT_TOOLS. Every spawn starts clean. */
const SCRUB_ENV_KEYS = ["MCP_DIRECT_TOOLS"] as const;
const SCRUB_ENV_PREFIXES = ["PI_", "JITI_", "MEMPALACE_"] as const;

interface ProbeLine {
	ts: string;
	turn: number;
	sha256: string;
	length: number;
	mempalaceMarker: boolean;
	task: string;
}

// Dummy provider: connection-refused at 127.0.0.1:1 — pi starts, fires
// before_agent_start, then fails the model call. Nonzero-safe.
const MODELS_JSON = JSON.stringify(
	{
		providers: {
			dummy: {
				name: "Dummy Refused Provider",
				baseUrl: "http://127.0.0.1:1/v1",
				api: "openai-completions",
				apiKey: "dummy-key",
				compat: {
					supportsDeveloperRole: false,
					supportsReasoningEffort: false,
					maxTokensField: "max_tokens",
				},
				models: [
					{
						id: "test",
						name: "Test",
						reasoning: false,
						input: ["text"],
						contextWindow: 8192,
						maxTokens: 1024,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					},
				],
			},
		},
	},
	null,
	"\t",
);

const SETTINGS_JSON = JSON.stringify(
	{ defaultProvider: "dummy", defaultModel: "test" },
	null,
	"\t",
);

// No pi.extensions manifest here: loading is hermetic via --no-extensions +
// explicit --extension flags (see spawnPi). The manifest path also merges
// AMBIENT packages from the default agent dir (pi-lens LSP etc.), which can
// wedge scratch children under sandbox before before_agent_start fires
// (parent-verified root cause of the original stall, 2026-08-28).
const PACKAGE_JSON = JSON.stringify(
	{ name: "scratch-agent", type: "module" },
	null,
	"\t",
);

function pathExists(p: string): boolean {
	return existsSync(p);
}

function isExecutable(p: string): boolean {
	try {
		accessSync(p, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/** Resolved synchronously at module load, because the {skip} test option is
 *  evaluated at registration time, before any before() hook runs. The
 *  installed runtime, never a node_modules/.bin dev-dependency copy. */
function resolvePiBinSync(): string | null {
	const override = process.env.PI_MEMPALACE_INT_PI_BIN;
	if (override) return isExecutable(override) ? override : null;
	for (const dir of (process.env.PATH ?? "").split(":")) {
		if (!dir || /[\\/]node_modules[\\/]\.bin[\\/]?$/.test(dir)) continue;
		const candidate = join(dir, "pi");
		if (isExecutable(candidate)) return candidate;
	}
	const fallback = join(homedir(), ".npm-global", "bin", "pi");
	return isExecutable(fallback) ? fallback : null;
}

const piBin = resolvePiBinSync();
const PI_SKIP = piBin === null
	? "pi binary not found on PATH outside node_modules/.bin (set PI_MEMPALACE_INT_PI_BIN)"
	: undefined;

/** Pre-change tree for AC-A3: the env dir, else `git archive` of the ref
 *  extracted into `dest`. Returns the dir, or the skip reason. */
function materialisePreChange(dest: string): { dir: string } | { skip: string } {
	if (PRE_CHANGE_DIR_ENV) {
		return existsSync(PRE_CHANGE_DIR_ENV)
			? { dir: PRE_CHANGE_DIR_ENV }
			: { skip: `pre-change dir not found at ${PRE_CHANGE_DIR_ENV} (PI_MEMPALACE_PRE_CHANGE_DIR)` };
	}
	const git = (...args: string[]) =>
		execFileSync("git", ["-C", REPO_ROOT, ...args], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	let ref = process.env.PI_MEMPALACE_PRE_CHANGE_REF ?? "";
	try {
		if (!ref) ref = git("merge-base", "HEAD", "origin/main");
		const tar = `${dest}.tar`;
		git("archive", "--format=tar", "-o", tar, ref);
		mkdirSync(dest, { recursive: true });
		execFileSync("tar", ["-xf", tar, "-C", dest]);
		return { dir: dest };
	} catch {
		return {
			skip: `could not materialise the pre-change tree from ${ref || "merge-base HEAD origin/main"} (set PI_MEMPALACE_PRE_CHANGE_DIR or PI_MEMPALACE_PRE_CHANGE_REF)`,
		};
	}
}

/** Scratch agent dir: provider + session storage only. No extensions/
 *  manifest — extension loading happens via explicit --extension flags. */
async function buildScratchAgent(root: string): Promise<string> {
	const agent = join(root, "agent");
	await mkdir(agent, { recursive: true });
	await writeFile(join(agent, "models.json"), MODELS_JSON);
	await writeFile(join(agent, "settings.json"), SETTINGS_JSON);
	await writeFile(join(agent, "package.json"), PACKAGE_JSON);
	return agent;
}

// ── shared run state ──────────────────────────────────────────────────────────

let runRoot = "";
let workDir = "";
let palaceDir = "";
let agentDir = "";
let linkedPreNodeModules = "";
let preChange: { dir: string } | { skip: string } = { skip: "pre-change tree not prepared (pi binary missing)" };

async function runOnce(args: string[], env: NodeJS.ProcessEnv): Promise<string> {
	let stderr = "";
	await new Promise<void>((resolve) => {
		// stdin MUST be "ignore": an open stdin pipe (execFile's default) makes
		// `pi --print` wait for EOF forever in non-TTY runs — the root cause
		// of the original suite stall (parent-verified, 2026-08-28).
		// stdout is also "ignore": nothing reads it here, and an unread
		// pipe would block the child once its stdout exceeds the OS pipe
		// buffer (~64KB), re-creating the stall as a silent SIGKILL (review
		// follow-up). stderr stays piped and is drained below.
		const child = spawn(piBin!, args, {
			cwd: workDir,
			env,
			stdio: ["ignore", "ignore", "pipe"],
			signal: AbortSignal.timeout(90_000),
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (d: string) => {
			stderr += d;
		});
		const killTimer = setTimeout(() => child.kill("SIGKILL"), 60_000);
		child.on("close", () => {
			clearTimeout(killTimer);
			resolve();
		});
		child.on("error", () => {
			clearTimeout(killTimer);
			resolve();
		});
	});
	return stderr;
}

async function spawnPi(opts: {
	task: string;
	/** Extension root whose index.ts is loaded (working tree or pre-change worktree). */
	extRoot: string;
	label: string;
	env?: Record<string, string | undefined>;
}): Promise<ProbeLine[]> {
	const probeDir = join(runRoot, "probe", opts.label);
	await mkdir(probeDir, { recursive: true });

	const env: NodeJS.ProcessEnv = { ...process.env };
	for (const k of Object.keys(env)) {
		if (SCRUB_ENV_PREFIXES.some((p) => k.startsWith(p))) delete env[k];
	}
	for (const k of SCRUB_ENV_KEYS) delete env[k];
	delete env.PROMPT_PROBE_DIR;
	Object.assign(env, {
		PI_CODING_AGENT_DIR: agentDir,
		MEMPALACE_PALACE: palaceDir,
		PROMPT_PROBE_DIR: probeDir,
		...opts.env,
	});

	// Hermetic child invocation — mirrors the pi-subagents canonical spawn
	// (its src/runs/shared/pi-args.ts): no ambient extension/package/skill/
	// context-file discovery; extensions load explicitly, flag order =
	// registration order, probe LAST (PRD AC-A1). Nonzero exit is expected:
	// the dummy provider refuses the connection AFTER before_agent_start.
	const args = [
		"--print",
		"--no-extensions",
		"--extension", join(opts.extRoot, "index.ts"),
		"--extension", join(REPO_ROOT, "tests", "helpers", "prompt-probe", "index.ts"),
		"--no-skills",
		"--no-context-files",
		opts.task,
	];

	const probeFile = join(probeDir, "probe.jsonl");
	const readProbe = async (): Promise<string | null> => {
		try {
			return await readFile(probeFile, "utf8");
		} catch {
			return null;
		}
	};

	let stderr1 = "";
	let raw = await readProbe().then(async (r) => {
		if (r !== null) return r;
		stderr1 = await runOnce(args, env);
		return readProbe();
	});
	if (raw === null) {
		// Single retry — belt+braces against any residual startup flake.
		const stderr2 = await runOnce(args, env);
		raw = await readProbe();
		if (raw === null) {
			// Both runs' stderr reaches the failure message (review follow-up):
			// discarding run-1's stderr hid the actual first-failure cause.
			const tail = (s: string) => s.slice(-600).trim() || "(none)";
			assert.fail(
				`probe never fired for ${opts.label} — before_agent_start did not run` +
				`; pi stderr (run-1): ${tail(stderr1)}` +
				`; pi stderr (run-2): ${tail(stderr2)}`,
			);
		}
	}
	const lines = raw!
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as ProbeLine);
	assert.ok(lines.length >= 1, `probe must fire at least once for ${opts.label}`);
	return lines;
}

before(async () => {
	if (!piBin) return; // tests skip via PI_SKIP

	runRoot = await mkdtemp(join(TMP_BASE, "mempalace-int-"));
	workDir = join(runRoot, "cwd");
	palaceDir = join(runRoot, "palace");
	await mkdir(workDir, { recursive: true });
	await mkdir(palaceDir, { recursive: true });

	agentDir = await buildScratchAgent(join(runRoot, "scratch"));

	preChange = materialisePreChange(join(runRoot, "pre-change"));
	if ("dir" in preChange) {
		// The tree has no node_modules (gitignored); borrow the repo's: the
		// parent prompt depends on the extension source, not on dev deps.
		const nm = join(preChange.dir, "node_modules");
		if (!pathExists(nm)) {
			await symlink(join(REPO_ROOT, "node_modules"), nm, "dir");
			linkedPreNodeModules = nm;
		}
	}
});

after(async () => {
	if (linkedPreNodeModules) await rm(linkedPreNodeModules, { force: true }).catch(() => {});
	if (runRoot) await rm(runRoot, { recursive: true, force: true }).catch(() => {});
});

describe("AC-A1 sibling children: identical prompts, no wake-up block", () => {
	it("two real children with different tasks hash identically and carry no [MemPalace Session Context]", { timeout: 180_000, skip: PI_SKIP }, async () => {
		const childEnv = { PI_SUBAGENT_CHILD: "1", PI_SUBAGENT_CHILD_AGENT: "worker" } as const;
		const a = (await spawnPi({
			task: "child task alpha: count the vowels in the word 'sequoia'",
			extRoot: REPO_ROOT,
			label: "sibling-a",
			env: { ...childEnv },
		}))[0];
		const b = (await spawnPi({
			task: "child task beta: reverse the word 'palindrome' and count letters",
			extRoot: REPO_ROOT,
			label: "sibling-b",
			env: { ...childEnv },
		}))[0];

		assert.equal(a.mempalaceMarker, false, "child A must not carry the wake-up block");
		assert.equal(b.mempalaceMarker, false, "child B must not carry the wake-up block");
		assert.equal(a.sha256, b.sha256, "sibling children must hash identically (no per-child prompt variance)");
		assert.ok(a.length > 0 && a.length === b.length, "non-empty prompts of equal length");
		assert.notEqual(a.task, b.task, "sibling task texts differ by construction");
	});
});

describe("AC-A4 escape hatch", () => {
	it("child + PI_MEMPALACE_CHILD_WAKEUP=1 → wake-up block PRESENT (non-vacuity control)", { timeout: 180_000, skip: PI_SKIP }, async () => {
		const [h] = await spawnPi({
			task: "hatch fleet task: wake-up must be present here",
			extRoot: REPO_ROOT,
			label: "hatch-fleet",
			env: { PI_SUBAGENT_CHILD: "1", PI_MEMPALACE_CHILD_WAKEUP: "1" },
		});
		assert.equal(h.mempalaceMarker, true, "fleet hatch re-enables the wake-up block");
	});

	it("child + WAKEUP=1 + AGENTS=scout with PI_SUBAGENT_CHILD_AGENT=worker → block ABSENT", { timeout: 180_000, skip: PI_SKIP }, async () => {
		const [s] = await spawnPi({
			task: "hatch scoped-miss task: worker is not scout",
			extRoot: REPO_ROOT,
			label: "hatch-scoped-miss",
			env: {
				PI_SUBAGENT_CHILD: "1",
				PI_SUBAGENT_CHILD_AGENT: "worker",
				PI_MEMPALACE_CHILD_WAKEUP: "1",
				PI_MEMPALACE_CHILD_WAKEUP_AGENTS: "scout",
			},
		});
		assert.equal(s.mempalaceMarker, false, "csv-scoped hatch must stay off for out-of-scope agents");
	});

	it("child + WAKEUP=1 + AGENTS listing the agent → block PRESENT", { timeout: 180_000, skip: PI_SKIP }, async () => {
		const [m] = await spawnPi({
			task: "hatch scoped-hit task: worker is listed",
			extRoot: REPO_ROOT,
			label: "hatch-scoped-hit",
			env: {
				PI_SUBAGENT_CHILD: "1",
				PI_SUBAGENT_CHILD_AGENT: "worker",
				PI_MEMPALACE_CHILD_WAKEUP: "1",
				PI_MEMPALACE_CHILD_WAKEUP_AGENTS: "scout, worker",
			},
		});
		assert.equal(m.mempalaceMarker, true, "csv-scoped hatch opens for the listed agent");
	});
});

describe("AC-A3 parent invariance: prompt hash unchanged pre/post change", () => {
	it("parent spawn hashes identically against the pre-change worktree", {
		timeout: 180_000,
		skip: PI_SKIP,
	}, async (t) => {
		if ("skip" in preChange) {
			t.skip(preChange.skip);
			return;
		}
		const task = "parent invariance task: compare my system prompt hash";
		const post = (await spawnPi({ task, extRoot: REPO_ROOT, label: "parent-post" }))[0];
		const pre = (await spawnPi({ task, extRoot: preChange.dir, label: "parent-pre" }))[0];

		assert.equal(post.mempalaceMarker, true, "post-change parent keeps the wake-up block");
		assert.equal(pre.mempalaceMarker, true, "pre-change parent keeps the wake-up block");
		assert.equal(post.sha256, pre.sha256, "parent prompt hash must be byte-identical pre/post change (G3)");
	});
});

describe("AC-A6 fork-child stability + upstream contract pin", () => {
	it("curation-style fork children produce identical prompt hashes across spawns", { timeout: 180_000, skip: PI_SKIP }, async () => {
		const childEnv = { PI_SUBAGENT_CHILD: "1", PI_SUBAGENT_CHILD_AGENT: "worker" } as const;
		const task = "curation fork task: mine this transcript into the palace";
		const f1 = (await spawnPi({ task, extRoot: REPO_ROOT, label: "fork-1", env: { ...childEnv } }))[0];
		const f2 = (await spawnPi({ task, extRoot: REPO_ROOT, label: "fork-2", env: { ...childEnv } }))[0];

		assert.equal(f1.mempalaceMarker, false, "fork child carries no wake-up block");
		assert.equal(f2.mempalaceMarker, false, "fork child carries no wake-up block");
		assert.equal(f1.sha256, f2.sha256, "fork-child prompt hash stable across curation spawns");
	});

	it("pi-subagents upstream still sets PI_SUBAGENT_CHILD=\"1\" for children", (t) => {
		const pkgDir = PI_SUBAGENTS_PKG;
		if (!existsSync(pkgDir)) {
			t.skip(`pi-subagents package not found at ${pkgDir} (set PI_SUBAGENTS_PKG_DIR)`);
			return;
		}
		// Search the whole source tree, not one file: upstream moved the
		// constant (pi-args.ts → child-runtime-config.ts) and the assignment
		// (into the child-hosting runner) without changing the contract.
		const srcDir = join(pkgDir, "src");
		const sources = existsSync(srcDir)
			? (readdirSync(srcDir, { recursive: true }) as string[])
				.filter((f) => f.endsWith(".ts") && !/(^|[\\/])(test|tests|__tests__)[\\/]|\.test\.ts$/.test(f))
				.map((f) => readFileSync(join(srcDir, f), "utf8"))
			: [];
		if (sources.length === 0) {
			t.skip(`no TypeScript sources under ${srcDir} \u2014 package layout changed, update the pin`);
			return;
		}
		assert.ok(
			sources.some((s) => /SUBAGENT_CHILD_ENV\s*=\s*["']PI_SUBAGENT_CHILD["']/.test(s)),
			"PI_SUBAGENT_CHILD env-var name contract (pi-subagents SUBAGENT_CHILD_ENV)",
		);
		assert.ok(
			sources.some((s) => /env\[SUBAGENT_CHILD_ENV\]\s*=\s*["']1["']/.test(s)),
			'PI_SUBAGENT_CHILD set-to-"1" assignment contract (pi-subagents) \u2014 the gate silently stops working upstream otherwise',
		);
	});
});
