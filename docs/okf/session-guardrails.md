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
- id: guardrail-ops
  resource: repo:///docs/guardrails-and-provider-usage.md
- id: spec-v2
  resource: repo:///specs/v2/session-guardrails.md
- id: arch-doc
  resource: repo:///docs/architecture.md
---

## Independence from Permissions

Session guardrails are a root-Session-family safety boundary independent of agent permissions and autonomy mode; permission approval does not bypass guardrails and guardrail approval does not widen an agent permission denial.[^runtime-doc]

## Evaluation Order

An unoverrideable standard catastrophic deny applies first, then the first matching custom source layer from nearest repository to broader repositories to global config, then standard mandatory review, then standard allow fallback.[^spec-v2]

Within one custom source layer, matching rules sort by descending numeric priority and then deterministic lexical file-path and rule-ID order.[^guardrail-ops]

## Mediation Scope

Guardrails mediate direct Session shell, tool shell, edit, write, patch, subagent launch, mutation-capable MCP tools, and project-artifact mutation at the side-effect boundary.[^runtime-doc]

Recognized catastrophic shell commands are denied before process creation, while recognized high-impact shell and mutation actions create a distinct human review.[^runtime-doc]

## Review Behavior

Guardrail reviews remain reviews in normal, yolo 1-2, and goal modes; only yolo 3 auto-approves guardrail reviews and TUI permission auto-approve never auto-approves guardrails.[^runtime-doc]

Replies are once, always, or reject; always is transient process-memory reuse for the exact root Session family, action, ordered rule IDs, ordered resources, and request metadata only after a fresh evaluation still asks.[^runtime-doc]

Running shell, running subagent, and pending review caps are shared by the root Session family with defaults of 8, 8, and 16, and release on settlement or interruption.[^guardrail-ops]

## Custom Rules and Rehydration

Custom rules load from direct guardrails children of the global YCoding config directory and every discovered repository Config.Directory; malformed enabled custom files fail mutation actions closed with review while keeping read-only actions available.[^runtime-doc]

Pending reviews rehydrate through the canonical Session guardrail API and live events, including reviews initiated by child sessions.[^runtime-doc]

After a 500 ms pending-review checkpoint, the TUI emits a root-owned Guardrail approval needed notification with the permission sound unless the review resolves first.[^runtime-doc]

## Related Concepts

- [Session Execution and Autonomy](./session.md)
- [Durable Background Subagents](./subagents.md)
- [Package Architecture](./architecture.md)

[^runtime-doc]: repo:///docs/runtime.md
[^spec-v2]: repo:///specs/v2/session-guardrails.md
[^guardrail-ops]: repo:///docs/guardrails-and-provider-usage.md
