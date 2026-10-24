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
  resource: repo:///specs/session-guardrails.md
- id: arch-doc
  resource: repo:///docs/architecture.md
- id: guardrail-core
  resource: repo:///packages/core/src/session/guardrail.ts
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

The root family's guardrails mode determines review handling: Manual requires a human, Auto approves ordinary standard reviews only while awake, and YOLO enables the guardrail evaluator. Hard and custom-rule review approvals require a human in every mode; a goal grants no review authority, and hard reviews cannot reuse an Always approval.[^runtime-doc]

Outside-repository ordinary reviews use deterministic matching followed by the root family's effective guardrails mode. Standard-match verification additionally requires YOLO and `guardrails.decide_reviews`; Manual and Auto have no model fallback. Explicit denies, hard and custom rules, concurrency caps, and `skipReview` retain their gates.[^spec-v2][^guardrail-core]

Configuration recovery treats guardrails as one security unit: any invalid value, including an unknown property, becomes { "enabled": true } with default limits of 8 shells, 8 subagents, and 16 pending reviews. Invalid permission rules preserve valid order and append action-wide or all-action denies; diagnostics identify the rejected JSON path and failClosed: true without changing ordinary configuration-scope precedence.[^spec-v2]

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
[^spec-v2]: repo:///specs/session-guardrails.md
[^guardrail-ops]: repo:///docs/guardrails-and-provider-usage.md
[^guardrail-core]: repo:///packages/core/src/session/guardrail.ts
