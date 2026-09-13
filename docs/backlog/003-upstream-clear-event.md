# 003 — Watch: upstream clear event for `request-attention`

Status: watch

## Context

ADR-0001 chose a transient toast because pi-claude-sandbox emits no clear/release counterpart to `request-attention`. A persistent surface (banner, status line) becomes viable only if the emitter adds one.

## Task

When pi-claude-sandbox ships a clear/release event: revisit ADR-0001, decide transient toast vs. persistent surface, and extend the event contract in [../attention.md](../attention.md).

## Acceptance

- ADR-0001 records the revisit (superseded or reaffirmed).
- The attention doc's contract section names the new event.
