# 004 — Reconcile the parent clone's untracked BRDs

Status: open — needs owner decision

## Context

The parent monorepo clone at `~/Documents/projects/personal/pi-extensions/pi-mempalace` carries an **untracked** `docs/` with two BRDs (inspected read-only from this worktree; nothing written there):

- `brd-p2-repo-wing-diary-hint.md` (1.7K) — records the repo-wing curation/wake-up design. Both commits it cites (`d38baa3`, `2d107a8`) are in history and touch exactly those files, so it reads as **already implemented** (verify, then mark implemented/archived).
- `brd-daemon-lifecycle-and-job-queue.md` (16.9K, marked *Draft — awaiting approval*) — daemon lifecycle + job-queue routing; **no matching implementation** found in history.

Resolving this also closes parent monorepo backlog item 6 ("pi-mempalace (untracked docs/)").

## Task

Owner decision, two parts:

1. p2 BRD: confirm the implementation claim in the parent clone, then mark it implemented/archived on the parent side.
2. Daemon BRD: adopt as a tracked item in this backlog, or leave it with the parent.

## Acceptance

- Each BRD has a tracked home: implemented/archived, or a live backlog entry.
- The parent clone's `docs/` disposition is reflected in its backlog item 6.
