# 007 — Detect diary writes routed through the `mcp` gateway tool

Status: open · P3

## Context

`tool_execution_start` marks a run as already-diarised only when a tool name
ends in `mempalace_diary_write`. When the diary-write tool is invoked through
the generic `mcp` gateway instead of being registered directly, the call
arrives as `toolName: "mcp"` with the real tool inside `args` — the mark never
fires, and the settle nudges a run that already diarised.

## Task

In `tool_execution_start`, also match `toolName === "mcp"` whose `args.tool`
ends in `mempalace_diary_write`, so a run that diarised via the gateway is not
nudged again.

## Acceptance

- A gateway diary write (`toolName "mcp"`, `args.tool` ending in `mempalace_diary_write`) marks the run; its settle sends no nudge.
- Gateway calls for other tools still leave the mark unset.
- Malformed `args` never throw from the hook.
