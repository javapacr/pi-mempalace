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
│   └── mining.usecase.ts         # Session transcript mining before compaction
├── domain/                       # Pure business logic (no I/O)
│   ├── types.ts                  # Core types (SessionState, MempalaceConfig, etc.)
│   ├── palace-router.ts          # Reads mempalace.yaml → palace/wing resolution
│   ├── recall-parser.ts          # Parses search snippets into recall context
│   └── curation-prompt.ts        # Builds curation subagent prompts
├── infrastructure/               # External integrations
│   ├── mempalace-cli.ts          # Wraps the `mempalace` CLI commands
│   └── event-registration.ts     # Registers lifecycle hooks with pi
├── ui/
│   └── recall-renderer.ts        # Custom TUI rendering for recall results
└── tools/                        # Dormant maintenance tools (NOT registered)
    ├── delete-wing.tool.ts       # Delete all drawers in a wing (dry-run capable)
    ├── repair-fts5.tool.ts       # Rebuild ChromaDB FTS5 full-text index
    └── scripts/                  # Python helpers called by the tools
        ├── delete-wing.py
        └── repair-fts5.py
```

## Active Features (Lifecycle Hooks)

| Event                        | Description                                                         |
| ---------------------------- | ------------------------------------------------------------------- |
| `session_start`              | Load wake-up context (L0+L1 ~940 tokens) into system prompt; reset conversation counter |
| `before_agent_start`         | Recall per-prompt memories and inject into system prompt            |
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

## Known Issues

- **Tools are dormant** — `delete-wing` and `repair-fts5` are implemented but intentionally not registered. Enable manually if needed.
- **Python dependency** — The dormant tools require `python3` on PATH and the scripts under `tools/scripts/`.
- **Session lifecycle coupling** — The extension is tightly coupled to the MemPalace CLI and MCP server. If the palace database is unavailable, recall and wake-up will degrade gracefully but curation/mining will fail.

## License

MIT © [javapacr](https://github.com/javapacr)
