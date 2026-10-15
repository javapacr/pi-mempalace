# 009 — Curation prompt names the diary tool by exact name

Status: open · P3

## Context

`domain/curation-prompt.ts` step 4 tells the agent to call
`mempalace_mempalace_diary_write`, an exact name. This profile registers
`mempalace-personal_mempalace_diary_write` (plan E8). The W1 settle gate
matches the diary tool by suffix and is not affected. But D17 relies on the
checkpoint prompt to cover the diary on the settle where the nudge yields, so
that cover depends on the model resolving the name by suffix.

## Task

Make the curation prompt name the diary tool in a palace-agnostic way. For
example, refer to "the tool ending in `mempalace_diary_write`", or interpolate
the registered name found via `hasDiaryTool`'s lookup.

## Acceptance

- The checkpoint prompt never hard-codes a single palace prefix for the diary tool.
- `npm run typecheck` and `npm test` stay green.
