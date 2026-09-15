---
type: Decision
title: Terminal-First Product Direction
description: YCoding is a standalone terminal-first coding agent with durable execution,
  explicit autonomy, background orchestration, provider-efficient model usage, and
  an approved native Godot desktop client.
tags:
- product
- terminal-first
- scope
- compatibility
sources:
- id: product-dir
  resource: repo:///docs/product-direction.md
- id: readme
  resource: repo:///README.md
- id: migration
  resource: repo:///docs/ycoding-migration.md
- id: office-agents
  resource: repo:///apps/office/AGENTS.md
---

## Product Identity

YCoding is a standalone coding agent; the terminal application is the primary product and release surface, and a native Godot desktop client under `apps/office/` is an explicitly approved additional presentation surface in development that consumes the same public service contracts and owns no execution authority.[^product-dir] Electron, browser-product, console, website, hosted-application, and legacy SDK products must not be restored and are not the native client.[^product-dir]

The desktop client is deliberately outside the Bun workspace and outside the `script/ycoding-workspace.ts` allowlist, so the terminal artifact closure is unchanged.[^office-agents]

The product goal is a dependable, highly customizable coding-agent runtime with durable execution state, explicit orchestration, and provider-efficient model usage.[^product-dir]

## Priorities

Sessions preserve user intent and execution state across ordinary process lifecycle boundaries; process-local coordinators may optimize execution but cannot own user-visible state.[^product-dir]

Autonomy supports normal, yolo 0-3, and goal modes with permission ceilings and Session guardrails; only effective yolo 3 auto-approves guardrail reviews and completion claims require verification evidence.[^product-dir]

Subagents are durable background child sessions with explicit agent selection, bounded nesting, permission ceilings, and parent-child ownership.[^product-dir]

Customization covers agents, commands, skills, hooks, plugins, TUI slots, MCP servers and tools, artifacts, providers, guardrails, and provider-usage sources.[^product-dir]

## Compatibility and Completeness

Durable data is preserved or explicitly migrated, generated Client output matches the assembled public HttpApi, plugins use current contracts, configuration uses the current Schema without hidden fallbacks, and external provider identities are preserved where required for interoperability.[^product-dir]

A product change is complete only with the real runtime path, targeted regression tests, affected typechecks, regenerated output, terminal-path verification, matching documentation, and no placeholder or mock-only behavior presented as production.[^product-dir]

## Related Concepts

- [Session Execution and Autonomy](./session.md)
- [Durable Background Subagents](./subagents.md)
- [Provider Usage Snapshots](./provider-usage.md)
- [Package Architecture](./architecture.md)

[^product-dir]: repo:///docs/product-direction.md
[^office-agents]: repo:///apps/office/AGENTS.md
