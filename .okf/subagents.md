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
- id: agents
  resource: repo:///AGENTS.md
---

## Durable Child Sessions

Subagents are durable child sessions and always launch in the background. Parent sessions receive lifecycle updates and can inspect child state after reconnect or restart.[^runtime-doc]

## Ownership and Nesting

Orchestration preserves explicit agent selection, bounded nesting, permission ceilings, and parent-child ownership. In-memory task lists are not a substitute for durable orchestration.[^product-dir]

## Rehydration

TUI subagent indicators must rehydrate from durable state after reconnect or restart. Requiring the user to enter each child session to rebuild counts is a defect.[^agents]

## Lifecycle Communication

Parent sessions receive lifecycle updates from child subagents. Children report progress back to their parent session while maintaining durable execution state.[^runtime-doc]

## Related Concepts

- [Session Execution and Autonomy](./session.md) — subagents are durable child sessions
- [Session Guardrails](./session-guardrails.md) — guardrails mediate child session actions
- [Package Architecture](./architecture.md) — subagent orchestration is owned by Core

[^runtime-doc]: repo:///docs/runtime.md
[^product-dir]: repo:///docs/product-direction.md
[^agents]: repo:///AGENTS.md
