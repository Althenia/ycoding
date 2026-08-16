---
type: Architecture
title: Package Architecture and Dependency Direction
description: The YCoding repository enforces explicit package boundaries, directed
  dependencies, and state scopes driven by a TUI-only product identity.
tags:
- packages
- dependency
- boundaries
- state-scope
sources:
- id: arch-doc
  resource: repo:///docs/architecture.md
- id: readme
  resource: repo:///README.md
- id: contributing
  resource: repo:///CONTRIBUTING.md
- id: agents
  resource: repo:///AGENTS.md
---

## Dependency Direction

Dependencies flow from Schema to Core and Protocol, then from Core and Protocol to Server, then to Client, CLI, and TUI. UI provides primitives to TUI. AI and plugin packages are consumed by Core.[^arch-doc]

- **packages/schema** owns browser-safe branded IDs, public domain records, durable event payloads, and shared validation.[^arch-doc]
- **packages/protocol** owns the public Effect `HttpApi` operation groups, transport schemas, middleware declarations, and OpenAPI assembly inputs.[^arch-doc]
- **packages/core** owns session execution, instructions, permissions, filesystem, providers, configuration, subagent orchestration, project-artifact storage, and database schema.[^arch-doc]
- **packages/server** maps Protocol operations to Core services and owns process lifecycle.[^arch-doc]
- **packages/client** consumes the assembled Protocol implementing generated and handwritten API clients.[^arch-doc]
- **packages/cli** owns the `ycoding` executable, command parsing, local-service discovery, and TUI startup.[^arch-doc]
- **packages/tui** owns presentation and interaction, never canonical durable state.[^arch-doc]
- **packages/ai** implements provider request lowering and response normalization across OpenAI, Anthropic, compatible-provider, and media protocols.[^arch-doc]
- **packages/plugin** owns Effect and Promise plugin contracts, hooks, tools, and session extensions.[^arch-doc]

## State Scopes

State is scoped to process-global, Location, Session durable, Project durable, Global durable, and UI resident.[^arch-doc] Process-local coordinators optimize execution but cannot become the sole owner of user-visible state.[^readme]

## Runtime Flow

Terminal input flows through Client request, Protocol operation, Server handler, Location resolution, Core service, permission and guardrail mediation, durable admission, process-local execution wake, provider request through AI, durable events and projections, event feed, canonical Client reads, bounded TUI read model, and terminal render.[^arch-doc]

## Workspace Boundary

The active package set is explicit and enforced by `script/ycoding-workspace.ts`.[^arch-doc] Desktop, browser, console, website, and legacy SDK packages are outside the product boundary and must not be restored.[^contributing]

## Authority Order

When sources disagree, the order is: executable behavior and tests, Schema public shapes, Protocol operations, Core runtime behavior, `docs` documentation and `specs/v2` contracts, package AGENTS.md, generated clients, and upstream material last.[^agents]

## Related Concepts

- [Session Execution and Autonomy](./session.md) — sessions are the durable execution unit owned by Core
- [Session Guardrails](./session-guardrails.md) — guardrails mediate session shell and mutation actions
- [Durable Background Subagents](./subagents.md) — subagents are durable child sessions orchestrated by Core
- [Project Artifacts and Customization](./project-artifacts.md) — artifact storage lives in Core
- [Provider Integration and Cache](./provider-integration.md) — provider request lowering is owned by packages/ai
- [Coding Conventions](./repository-preference.md) — architecture authority order and package boundaries

[^arch-doc]: repo:///docs/architecture.md
[^readme]: repo:///README.md
[^contributing]: repo:///CONTRIBUTING.md
[^agents]: repo:///AGENTS.md
