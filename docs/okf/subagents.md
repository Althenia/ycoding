---
type: Workflow
title: Durable Background Subagents
description: Subagents are durable child sessions that run in the background with
  parent-child ownership, permission ceilings, explicit agent selection, and bounded
  nesting.
tags:
- subagents
- orchestration
- durable
- background
sources:
- id: runtime-doc
  resource: repo:///docs/runtime.md
- id: product-dir
  resource: repo:///docs/product-direction.md
- id: guardrail-ops
  resource: repo:///docs/guardrails-and-provider-usage.md
- id: agents
  resource: repo:///AGENTS.md
---

## Durable Child Sessions

Subagents are durable child sessions and always launch in the background; the tool returns the child Session ID immediately and the parent receives lifecycle state and completion or failure notification.[^runtime-doc]

Once a parent has no local runnable work, it completes its own response and is free even while child sessions continue in the background.[^runtime-doc]

## Ownership, Ceilings, and Nesting

Orchestration preserves explicit agent selection, bounded nesting, permission ceilings, and parent-child ownership; nested subagents are bounded by experimental.subagent_depth with default depth one.[^product-dir]

A child inherits deny rules from its parent permission ceiling and cannot widen a parent denial; managed subagents receive final deny rules for subagent and subagent_control so permissive child rules cannot enable nested orchestration.[^guardrail-ops]

Selectable primary built-ins are TLDR, architech, god, and yangi with god as the default, while occam, omoikane, wittgenstein, and zeus are maintained task subagents.[^runtime-doc]

## Lifecycle Communication

TeamView is a durable chronological team-view observation whenever its selected child-state text changes, available on every provider route as a synthetic user-authority message; an empty update clears a prior view when no children remain.[^runtime-doc]

Running children receive a status, blocker, and ETA request every ten minutes; an optional child timeout accepts at most 86400000 ms and defaults to 3600000 ms, interrupting and failing the child task on expiry.[^runtime-doc]

TUI subagent indicators rehydrate from durable state after reconnect or restart; requiring the user to open each child session to rebuild counts is a defect.[^agents]

## Related Concepts

- [Session Execution and Autonomy](./session.md)
- [Session Guardrails](./session-guardrails.md)
- [Package Architecture](./architecture.md)
- [Project Artifacts](./project-artifacts.md)

[^runtime-doc]: repo:///docs/runtime.md
[^product-dir]: repo:///docs/product-direction.md
[^guardrail-ops]: repo:///docs/guardrails-and-provider-usage.md
[^agents]: repo:///AGENTS.md
