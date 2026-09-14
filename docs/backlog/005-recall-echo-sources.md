# 005 — Recall echo sources: exclude/downrank session-JSONL in `mempalace search`

Status: open · P2 — palace-side (CLI layer, not this extension)

## Context

The child-recall gating scout run (2026-09-15, run `4711d536`, report
`subagent-artifacts/outputs/4711d536-3519-4db0-8b0e-4a071996e905/scout.md`)
sampled 22 child transcripts carrying `mempalace-recall` injections: 0 USED,
19 IGNORED — and **72% of the recalled snippets were echoes**, 59% of them
the child's own task text recalled back from sibling/own session-JSONL files
mined into the palace.

This extension now gates child recall by default (settings-driven —
`mempalace.children.recall`), but primary sessions still recall from the same
pool, so self/sibling transcript echoes keep diluting primary recall quality.

## Task

In the mempalace CLI's search path (not this repo): consider excluding
session-JSONL-derived entries from `mempalace search` results, or downranking
them below diary/drawer/KG sources — enough that a prompt's own task text
never surfaces as a "memory".

## Acceptance

- A query whose best literal match is the asking session's own task text no
  longer returns that text as a top snippet.
- Recall quality on primary sessions re-measured after the change (USED vs
  IGNORED ratio improves over the 0/19 baseline).
