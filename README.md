# pi-mempalace

MemPalace session lifecycle extension for [pi](https://github.com/earendil-works/pi) — palace-aware recall, wake-up context injection, automated curation, and session mining.

> **Note:** This extension handles the **session lifecycle hooks** (wake-up, recall, curation, mining) for MemPalace. The main MemPalace integration — semantic search, drawer management, knowledge graph, tunnels — runs through the `npm:pi-mcp-adapter` MCP server and the `mempalace` CLI, **not** this extension. This extension orchestrates those MCP tools across session events.

## Architecture

The extension follows a Domain-Driven Design (DDD) structure:

```
index.ts                          # Entry — wires up use cases + event registration
├── application/                  # Use cases (orchestration layer)
│   ├── wake-up.usecase.ts        # Loads L0+L1 wake-up context into system prompt
│   ├── recall.usecase.ts         # Per-prompt memory recall + injection
│   ├── curation.usecase.ts       # Automated diary/drawer/KG curation via subagents
│   ├── mining.usecase.ts         # Session transcript mining before compaction
│   └── skill-sync.usecase.ts     # Syncs bundled skills to ~/.pi/agent/skills/
├── domain/                       # Pure business logic (no I/O)
│   ├── types.ts                  # Core types (SessionState, MempalaceConfig, etc.)
│   ├── palace-router.ts          # Reads mempalace.yaml → palace/wing resolution
│   ├── recall-parser.ts          # Parses search snippets into recall context
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

| Event                        | Description                                                         |
| ---------------------------- | ------------------------------------------------------------------- |
| `session_start`              | Load wake-up context (L0+L1 ~940 tokens) into system prompt; reset conversation counter; skipped for subagent children (`PI_SUBAGENT_CHILD=1`) unless the `PI_MEMPALACE_CHILD_WAKEUP` hatch applies |
| `before_agent_start`         | Recall per-prompt memories and inject into system prompt (wake-up self-heal also gated for subagent children) |
| `agent_end`                  | Every 15 exchanges, dispatch a worker subagent for curation         |
| `session_before_compact`     | Mine the session transcript before summarisation                    |
| `session_shutdown`           | Background mine on quit                                             |

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
fetch/append, `syncSkills`, and `ensureMcp` at `session_start` — and the
`before_agent_start` self-heal retry — while keeping recall
(`RECALL_CUSTOM_TYPE`) and session-shutdown transcript mining (config
resolution is intentionally not gated). One-time stderr logs mark the skip
and any hatch use.

Escape hatch: `PI_MEMPALACE_CHILD_WAKEUP=1` (exact `"1"`, evaluated per
event) re-enables the gated behavior; `PI_MEMPALACE_CHILD_WAKEUP_AGENTS=<csv>`
scopes it against `PI_SUBAGENT_CHILD_AGENT` — an empty/absent csv is
fleet-wide, and the agent must match a trimmed csv token exactly.

## Known Issues

- **Tools are dormant** — `delete-wing` and `repair-fts5` are implemented but intentionally not registered. Enable manually if needed.
- **Python dependency** — The dormant tools require `python3` on PATH and the scripts under `tools/scripts/`.
- **Session lifecycle coupling** — The extension is tightly coupled to the MemPalace CLI and MCP server. If the palace database is unavailable, recall and wake-up will degrade gracefully but curation/mining will fail.

## License

MIT © [javapacr](https://github.com/javapacr)
