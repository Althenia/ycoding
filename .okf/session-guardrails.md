---
type: Workflow
title: Session Guardrails
description: Session guardrails provide a root-Session-family safety boundary independent
  of agent permissions and autonomy mode, mediating shell and mutation actions through
  human review.
tags:
- guardrails
- safety
- permissions
- review
sources:
- id: runtime-doc
  resource: repo:///docs/runtime.md
- id: spec-v2
  resource: repo:///specs/v2/session-guardrails.md
- id: arch-doc
  resource: repo:///docs/architecture.md
---

## Independence from Permissions

Session guardrails are a root-Session-family safety boundary independent of agent permissions and autonomy mode. Permission approval does not bypass guardrails, and guardrail approval does not widen an agent permission denial.[^runtime-doc]

## Mediation Scope

Guardrails mediate direct Session shell, tool shell, edit, write, patch, subagent launch, mutation-capable MCP tools, and project-artifact mutation.[^runtime-doc]

## Review Behavior

- Recognized catastrophic shell commands are denied before process creation.
- Recognized high-impact shell and mutation actions create a distinct human review.
- Guardrail reviews remain reviews in `normal`, `yolo`, and `goal` modes and are not affected by TUI permission auto-approve.
- Running shell, running subagent, and pending review caps are shared by the root Session family and release on settlement or interruption.[^runtime-doc]

## Custom Rules

Custom rules load from the global YCoding config `guardrails` directory. Malformed enabled custom files produce a visible invalid-file count and fail closed with review for mutation actions.[^runtime-doc]

## Rehydration

Pending reviews rehydrate through the canonical Session guardrail API and live events, including reviews initiated by child Sessions.[^runtime-doc]

## Location Scope

`SessionGuardrail` is Location-scoped but evaluates by Session ID. It resolves the root Session through `SessionStore`, shares counters across that family, and mediates mutation immediately before side effects.[^arch-doc]

## Related Concepts

- [Session Execution and Autonomy](./session.md) — guardrails mediate session shell and mutation actions
- [Durable Background Subagents](./subagents.md) — guardrails apply to child session actions
- [Package Architecture](./architecture.md) — guardrails are Location-scoped

[^runtime-doc]: repo:///docs/runtime.md
[^arch-doc]: repo:///docs/architecture.md
