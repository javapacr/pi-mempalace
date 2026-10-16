# pi-mempalace

MemPalace session lifecycle extension for [pi](https://github.com/earendil-works/pi) — palace-aware recall, wake-up context injection, automated curation, and session mining.

> **Note:** This extension handles the **session lifecycle hooks** (wake-up, recall, curation, mining) for MemPalace. The main MemPalace integration — semantic search, drawer management, knowledge graph, tunnels — runs through the `npm:pi-mcp-adapter` MCP server and the `mempalace` CLI, **not** this extension. This extension orchestrates those MCP tools across session events.

## Architecture

The extension follows a Domain-Driven Design (DDD) structure:

```
index.ts                          # Entry — wires up use cases + event registration
├── application/                  # Use cases (orchestration layer)
│   ├── wake-up.usecase.ts        # Loads L0+L1 wake-up context (injected as the `mempalace` prompt section)
│   ├── recall.usecase.ts         # Per-prompt memory recall + injection
│   ├── curation.usecase.ts       # Automated diary/drawer/KG curation via subagents
│   ├── mining.usecase.ts         # Session transcript mining before compaction
│   └── skill-sync.usecase.ts     # Syncs bundled skills to ~/.pi/agent/skills/
├── domain/                       # Pure business logic (no I/O)
│   ├── types.ts                  # Core types (SessionState, MempalaceConfig, etc.)
│   ├── palace-router.ts          # Reads mempalace.yaml → palace/wing resolution
│   ├── recall-parser.ts          # Parses search snippets into recall context
│   ├── diary-nudge.ts            # Settle/handoff nudge gates, diary-tool suffix match, nudge texts (pure)
│   ├── handoff-contract.ts       # pi-handoff event contract: channels, payload shapes, runtime parser (mirrored)
│   ├── curation-prompt.ts        # Builds curation subagent prompts
│   └── skill-sync.ts             # Skill sync planning logic (pure)
├── infrastructure/               # External integrations
│   ├── mempalace-cli.ts          # Wraps the `mempalace` CLI commands
│   ├── skill-installer.ts        # Filesystem operations for skill install/update
│   └── event-registration.ts     # Registers lifecycle hooks with pi
├── ui/
│   └── recall-renderer.ts        # Custom TUI rendering for recall results
├── tools/                        # Dormant maintenance tools (NOT registered)
│   ├── delete-wing.tool.ts       # Delete all drawers in a wing (dry-run capable)
│   ├── repair-fts5.tool.ts       # Rebuild ChromaDB FTS5 full-text index
│   └── scripts/                  # Python helpers called by the tools
│       ├── delete-wing.py
│       └── repair-fts5.py
└── skills/                       # Bundled skill files (source of truth)
    ├── mempalace/SKILL.md
    └── mempalace-recall/SKILL.md
```

## Active Features (Lifecycle Hooks)

| Event                         | Description                                                                                                                                                                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session_start`               | Load wake-up context (L0+L1 ~940 tokens); reset conversation counter; skipped for subagent children (`PI_SUBAGENT_CHILD=1`) unless the `PI_MEMPALACE_CHILD_WAKEUP` hatch applies                                         |
| `before_agent_start`          | Set the wake-up context as the `mempalace` system-prompt section (`systemPromptOptions.sections.mempalace`, rendered `<mempalace>…</mempalace>`) on **every** turn, short prompts included — never a forced `systemPrompt`, so pi keeps transcript deltas. Needs pi ≥ 0.86; older hosts skip wake-up injection with a one-time stderr log. Then recall per-prompt memories (prompts ≥ 10 chars) as a custom message; gated by settings (`recall_on_prompt` master switch; subagent children also need `children.recall`, default off) — the wake-up self-heal retry stays child-gated by the env hatch |
| `agent_end`                   | Every `save_interval` exchanges (default 15), inject an in-session curation checkpoint that files key items via the MemPalace MCP tools; runs triggered by the diary nudge are excluded from the count and skip the checkpoint; subagent children skip it unless `children.curation` is set (default off)                          |
| `agent_settled`               | After every settled run in interactive TUI mode that made at least `mempalace.diary_settle_min_tool_calls` tool calls (the activity threshold, default 3; 0 = every settle), send one hidden diary nudge (`display:false`, `triggerTurn:true`, followUp): write one MemPalace diary entry if anything durable happened, else reply one short line and start no new work. Skips: the nudge's own run, aborted settles, subagent children, non-TUI modes (print/json/rpc), a handoff in progress, runs that already called the diary tool, runs whose `agent_end` just queued the curation checkpoint (its prompt already asks for a diary write, and on pi ≥ 1.2 a nudge run would carry that pending checkpoint into itself), and sessions with no tool ending in `mempalace_diary_write` registered — the diary-write tool must be registered directly (not reachable only through an MCP gateway). Known limitation: a diary write routed through the `mcp` gateway tool is not detected, so that run still gets a redundant nudge ([backlog 007](docs/backlog/007-mcp-gateway-diary-detection.md)). Off switch: `mempalace.diary_on_settle` |
| `tool_execution_start` / `input` | Count the run's tool calls toward the activity threshold, and mark the run as already-diarised when a tool name ends in `mempalace_diary_write`; the user's next interactive `input` closes the handoff-in-progress window below (nudge runs never fire `input`) |
| pi.events `handoff_command_start` | pi-handoff's `/handoff`, after its has-conversation gate: raise the handoff-in-progress window and send one hidden handoff nudge — only for `trigger:"handoff"` with a function `waitUntil`, which receives a promise resolving on the next `agent_settled` (aborted or not), registered synchronously before the listener returns and released after 125s at the latest (the wait self-bound). When a curation checkpoint is still queued, the nudge uses a checkpoint-variant text: finish the checkpoint concisely (it includes the diary write), then stop. An unrecognised payload (missing/unknown trigger, or `trigger:"handoff"` without `waitUntil`) shows one drift warning per session. A bare `/continue` (`trigger:"continue"`), a missing/unknown trigger, or a missing `waitUntil` sends nothing (a missing `waitUntil` still raises the window). Same gates as the tool path below. Off switch: `mempalace.diary_on_handoff` |
| pi.events `handoff_tool_start` / `tui_filled_handoff` / `handoff_command_complete` | pi-handoff's continue path: `handoff_tool_start` opens the handoff-in-progress window (which keeps the settle nudge quiet until the handoff resolves) and sends one hidden handoff nudge, deduped per session; `tui_filled_handoff` (the installed continue tool's legacy signal) only opens the window; `handoff_command_complete` closes it |
| `session_before_compact`      | Mine the session transcript before summarisation                                                                                                                                                                                            |
| `session_shutdown`            | Background mine of the session transcript file on quit and session replacement (new/resume/fork; not reload)                                                                                                                                |
| pi.events `request-attention` | Listen for pi-claude-sandbox's sandbox-permission signal and surface it as a transient `ctx.ui.notify` toast (warning); no clear event exists — toast self-clears; payload stays in-process                                                 |

### pi-handoff event contract

pi-handoff emits on the shared bus; pi-mempalace mirrors the shapes in
`domain/handoff-contract.ts`, comment-pinned to pi-handoff e711e2b
(contract from javapacr/pi-handoff#3, 838ac31):

| Channel | When | Payload |
| ------- | ---- | ------- |
| `handoff_command_start` | `/handoff` passed its has-conversation gate, or bare `/continue` recovered a document | `{ goal, quickMode, trigger: "handoff" \| "continue", waitUntil?, timestamp }` |
| `handoff_tool_start` | The `continue` tool staged `/continue`, emitted right after `tui_filled_handoff` | `{ goal, command: "/continue", timestamp }` |
| `handoff_command_complete` | Either command finished (success, cancel or error) | `{ goal, quickMode, trigger, sessionTitle?, error?, timestamp }` |

`quickMode` is legacy and mirrors `trigger === "continue"` — read `trigger`.
A `/handoff` that fails the has-conversation gate emits neither start nor
complete. pi-mempalace acts only on `trigger:"handoff"` and only when
`waitUntil` is a function: it calls `waitUntil(promise)` synchronously inside
the handler — a call after the emit returns is silently ignored — and the
promise resolves on the next `agent_settled`, aborted or not. `/handoff`
awaits registered promises (`Promise.allSettled`) before its snapshot, capped
at 120s by pi-handoff: at the cap the handoff proceeds, and Esc cancels the
handoff while the diary turn continues in the current session. pi-mempalace
adds a defensive wait self-bound: an unref'd 125s timer releases its waits even
if no settle arrives and pi-handoff's cap fails; any settle or teardown clears
it first.

**Drift detection.** A `handoff_command_start` that pi-mempalace cannot act on
— a missing or unknown `trigger`, or `trigger:"handoff"` without a function
`waitUntil` (an older pi-handoff) — raises one drift warning per session
(only when the handoff nudge would otherwise run: enabled, a diary tool
registered, and not a subagent child).
`tests/handoff-contract-drift.test.ts` reads pi-handoff's
`infrastructure/event-channels.ts`, `domain/types.ts` and
`application/handoff-executor.ts` (from `PI_HANDOFF_DIR`, else the
`pi-handoff` sibling of the main checkout; skipped when neither exists) and
fails when a channel name, trigger value, payload field or the 120s cap
drifts.

## Dormant Maintenance Tools

These tools are implemented but **not registered** by default. Their code is kept so the implementation is not lost. To enable, call the factory function in `index.ts`:

```typescript
import { createDeleteWingTool } from "./tools/delete-wing.tool";
import { createRepairFts5Tool } from "./tools/repair-fts5.tool";

// In the extension entry:
pi.registerTool(createDeleteWingTool(pi));
pi.registerTool(createRepairFts5Tool(pi));
```

### `mempalace_delete_wing`

Delete all drawers and closets in a MemPalace wing. Runs in **dry-run mode** by default (returns counts only). Pass `dry_run=false` and `confirm=true` to perform actual deletion. Requires a `ctx.ui.confirm()` dialog before destructive operations.

### `mempalace_repair_fts5`

Rebuild the MemPalace ChromaDB FTS5 full-text index when SQLite reports corruption (e.g., "malformed inverted index"). Creates a timestamped backup, recreates the FTS5 virtual table from `embedding_metadata`, verifies `PRAGMA quick_check`, and optionally runs `mempalace repair --yes`.

## Skill Ownership

This extension now **owns the installation and updates** of the MemPalace agent skills (`mempalace`, `mempalace-recall`). It bundles copies of these skills (from `skills/` directory) and syncs them to `~/.pi/agent/skills/` on every session start.

### How it works

- On `session_start`, the extension checks each managed skill against the bundled version:
  - **MISSING**: Installs a real directory with SKILL.md and a `.pi-mempalace.json` marker
  - **SYMLINK** (from `npx skills`): Replaces the symlink with a real directory, taking ownership
  - **STALE** (hash differs): Updates the SKILL.md and marker
  - **CURRENT**: No-op
- The sync runs fire-and-forget — errors are swallowed to never block session startup
- A `.pi-mempalace.json` marker in each skill directory records the managedBy, skillHash, and syncedAt timestamp

### Manual sync command

Force a skill sync from the TUI or shell with:

```
/mempalace-skills-sync
```

This runs the sync synchronously and returns a per-skill result:

```
MemPalace skill sync:
mempalace: NOOP ✓
mempalace-recall: UPDATE ✓
```

### Replacing npx skills

Previously, the skills were installed via the `npx skills` CLI (the skills.sh ecosystem), which writes to `~/.agents/skills/` and creates symlinks in `~/.pi/agent/skills/`. The cross-agent lockfile `~/.agents/.skill-lock.json` and the `~/.agents/skills/` directory are **intentionally left untouched** — they may still be used by other agents (Cursor, Zed, etc.). The extension only manages the pi-specific skill files at `~/.pi/agent/skills/`.

If you previously installed the skills via `npx skills`, the symlink replacement happens automatically on first session start. The old npx lockfile entry remains but is harmless.

## Dependencies

| Package                              | Type     | Purpose                              |
| ------------------------------------ | -------- | ------------------------------------ |
| `@earendil-works/pi-coding-agent`    | peer     | Extension API types                   |
| `@earendil-works/pi-tui`             | peer     | TUI rendering (Text component)        |
| `typebox`                            | peer     | Tool parameter schemas               |
| `yaml`                               | runtime  | Parse `mempalace.yaml` config files   |
| `python3` (system)                   | optional | Required only for dormant tools       |

## Installation

```bash
# Clone
git clone https://github.com/javapacr/pi-mempalace.git

# Install dev dependencies
cd pi-mempalace
npm install

# Build check
bun build index.ts --no-bundle
```

## Child gate & escape hatch

Subagent children (`PI_SUBAGENT_CHILD=1`, fresh and fork) skip the wake-up
fetch (so no `mempalace` prompt section) and `syncSkills` at `session_start` — and the
`before_agent_start` self-heal retry — plus, by default, per-prompt recall
and the `agent_end` curation checkpoint. Recall/curation for children are
settings-driven (see [Settings](#settings)): `mempalace.children.recall` and
`mempalace.children.curation` default to `false` (primary-only), and the
`mempalace.recall_on_prompt: false` master switch disables recall everywhere.
Transcript mining (`session_before_compact`, `session_shutdown`) is never
gated. One-time stderr logs mark the wake-up skip and any hatch use.

Escape hatch: `PI_MEMPALACE_CHILD_WAKEUP=1` (exact `"1"`, evaluated per
event) re-enables the gated wake-up behavior; `PI_MEMPALACE_CHILD_WAKEUP_AGENTS=<csv>`
scopes it against `PI_SUBAGENT_CHILD_AGENT` — an empty/absent csv is
fleet-wide, and the agent must match a trimmed csv token exactly. The hatch
covers the wake-up leg only; the recall/curation gates read settings.

## Settings

Configured in pi settings under the `mempalace` key. Two files are merged
**per key** — project wins:

1. **Profile**: `$PI_CODING_AGENT_DIR/settings.json` (a relative
   `PI_CODING_AGENT_DIR` resolves against `~/.pi`; env unset →
   `~/.pi/agent/settings.json`)
2. **Project**: `<cwd>/.pi/settings.json`

A key that is absent or wrong-typed in the project file falls through to the
profile file, then to its default. A missing or malformed file contributes
nothing — the reader never throws, and each key falls back independently.
Settings are parsed once at `session_start` on every path (children and
print one-shots included); changes apply to the next session.

| Key                              | Type         | Default | What                                                                                               |
| -------------------------------- | ------------ | ------- | -------------------------------------------------------------------------------------------------- |
| `mempalace.palace`               | string       | unset   | Personal palace override in the env → settings → home-relative default chain; `""` counts as unset; routing currently consumes the profile leg only — the project palace value is parsed but not yet consumed (out-of-scope by plan) |
| `mempalace.save_interval`        | positive int | `15`    | Exchanges between `agent_end` curation checkpoints                                                 |
| `mempalace.recall_on_prompt`     | boolean      | `true`  | Master switch for `before_agent_start` recall — `false` disables recall everywhere                 |
| `mempalace.diary_on_settle`      | boolean      | `true`  | Settle diary nudge — `false` stops the hidden after-run diary prompt                               |
| `mempalace.diary_on_handoff`     | boolean      | `true`  | Handoff diary nudge — `false` stops the hidden before-snapshot diary prompt on both pi-handoff paths |
| `mempalace.diary_settle_min_tool_calls` | non-negative int | `3` | Activity threshold for the settle nudge — runs with fewer tool calls get no nudge; `0` nudges every qualifying settle |
| `mempalace.children.recall`      | boolean      | `false` | Subagent children run the per-prompt recall                                                        |
| `mempalace.children.curation`    | boolean      | `false` | Subagent children run the `agent_end` curation checkpoint                                          |

```jsonc
// user: $PI_CODING_AGENT_DIR/settings.json · project: <cwd>/.pi/settings.json
"mempalace": {
  "palace": "",
  "save_interval": 15,
  "recall_on_prompt": true,
  "diary_on_settle": true,
  "diary_on_handoff": true,
  "diary_settle_min_tool_calls": 3,
  "children": { "recall": false, "curation": false }
}
```

## Compatibility

| Component | Requirement | Verified |
| --------- | ----------- | -------- |
| pi | ≥ 1.1 (`agent_settled` carries `aborted`; older hosts treat an aborted settle as a normal one) | 1.3.0 |
| pi-handoff | ≥ 838ac31 for the handoff nudge (`trigger`, `waitUntil`, `handoff_tool_start`) | e711e2b |

With an older pi-handoff, the `/handoff` diary turn is inert and the drift
warning says so once per session; the settle nudge and the `tui_filled_handoff`
quiet window keep working.

## Known Issues

- **Tools are dormant** — `delete-wing` and `repair-fts5` are implemented but intentionally not registered. Enable manually if needed.
- **Python dependency** — The dormant tools require `python3` on PATH and the scripts under `tools/scripts/`.
- **Session lifecycle coupling** — The extension is tightly coupled to the MemPalace CLI and MCP server. If the palace database is unavailable, recall and wake-up will degrade gracefully but curation/mining will fail.

## License

MIT © [javapacr](https://github.com/javapacr)
