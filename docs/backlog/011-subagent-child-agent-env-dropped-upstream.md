# 011 — pi-subagents no longer exports `PI_SUBAGENT_CHILD_AGENT`, so the per-agent wake-up hatch is dead

Status: open · P2 · found during W3 (#6), 2026-10-16

## Context

The child gate (`domain/child-gate.ts`) honours two hatches. The fleet hatch is
`PI_MEMPALACE_CHILD_WAKEUP=1`. The per-agent hatch is
`PI_MEMPALACE_CHILD_WAKEUP_AGENTS=<csv>`, matched against
`PI_SUBAGENT_CHILD_AGENT`.

The installed pi-subagents (nicobailon/pi-subagents `475600bc`) has changed in
two ways:

- It hosts children in-process inside a runner. `src/runs/background/subagent-runner.ts`
  sets `process.env.PI_SUBAGENT_CHILD = "1"`. The constant now lives in
  `src/runs/shared/child-runtime-config.ts`; `pi-args.ts` is gone.
- Nothing in `src/` sets `PI_SUBAGENT_CHILD_AGENT` any more. Its own
  `test/integration/in-process-child.test.ts` deletes the variable so a parent
  value does not leak.

The fleet hatch and the child gate still work. The per-agent csv can never
match, so `PI_MEMPALACE_CHILD_WAKEUP_AGENTS` silently re-enables nothing. Our
int test still passes because it sets `PI_SUBAGENT_CHILD_AGENT` itself.

The runner also shares one process between children and applies per-child env
around session load (`child-session.ts` `applyProcessEnv`). Per-event
`process.env` reads in pi-mempalace may therefore see another child's values.
That needs a look too.

## Task

Pick one:

- Drop the per-agent hatch: remove the csv path, and update README "Child gate
  & escape hatch" and the int-test hatch cases.
- Read the agent name from a signal upstream still provides, such as an
  extension binding (`PI_SUBAGENT_EXTENSION_BINDINGS`) or session metadata, if
  one exists.
- Ask upstream to export the child agent name again.

Add a pin, like the AC-A6 `PI_SUBAGENT_CHILD` pin, that fails when the chosen
signal disappears.

## Acceptance

- `PI_MEMPALACE_CHILD_WAKEUP_AGENTS` either works against the installed
  pi-subagents or is removed, and the docs say which.
- A test pins the upstream signal the gate relies on.
