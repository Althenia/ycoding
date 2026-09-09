---
type: Architecture
title: Package Architecture and Dependency Direction
description: YCoding enforces a TUI-only package graph with directed Schema-to-Core/Protocol-to-Server
  dependencies and explicit state scopes.
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
- id: product-dir
  resource: repo:///docs/product-direction.md
- id: agents
  resource: repo:///AGENTS.md
- id: contrib
  resource: repo:///CONTRIBUTING.md
---

## Dependency Direction

Dependencies flow from Schema to Core and Protocol, then from Core and Protocol to Server, then to Client, CLI, and TUI; UI provides primitives to TUI, while AI and plugin packages are consumed by Core.[^arch-doc]

- **packages/schema** owns browser-safe branded IDs, public domain records, durable event payloads, and shared validation.[^arch-doc]
- **packages/protocol** owns the public Effect HttpApi operation groups, transport schemas, middleware declarations, and OpenAPI assembly inputs.[^arch-doc]
- **packages/core** owns session execution, instructions, permissions, filesystem, providers, subagent orchestration, project-artifact storage, and database schema.[^arch-doc]
- **packages/server** maps Protocol operations to Core services and owns process lifecycle.[^arch-doc]
- **packages/client** consumes the assembled Protocol through generated and handwritten API clients.[^arch-doc]
- **packages/cli** owns the ycoding executable, command parsing, local-service discovery, and TUI startup.[^arch-doc]
- **packages/tui** owns presentation and interaction, never canonical durable state.[^arch-doc]
- **packages/ai** implements provider request lowering and response normalization across OpenAI, Anthropic, compatible-provider, and media protocols.[^arch-doc]
- **packages/plugin** owns Effect and Promise plugin contracts, hooks, tools, and session extensions.[^arch-doc]

## State Scopes

State is scoped to process-global, Location, Session durable, Project durable, Global durable, and UI resident.[^arch-doc] Process-local coordinators optimize execution but cannot become the sole owner of user-visible state.[^product-dir]

## Runtime Flow

Terminal input flows through Client request, Protocol operation, Server handler, Location resolution, Core service, permission and guardrail mediation, durable admission, process-local execution wake, provider request through AI, durable events and projections, event feed, canonical Client reads, bounded TUI read model, and terminal render.[^arch-doc]

## Workspace Boundary

The active package set is explicit and enforced by script/ycoding-workspace.ts.[^arch-doc] Desktop, browser, console, website, statistics, hosted-application, and legacy SDK packages are outside the product boundary and must not be restored.[^contrib]

## Authority Order

When sources disagree, the order is executable behavior and tests, Schema public shapes, Protocol operations, Core runtime behavior, docs documentation and specs/v2 contracts, package AGENTS.md, generated clients, and upstream material last.[^agents]

## Related Concepts

- [Session Execution and Autonomy](./session.md)
- [Session Guardrails](./session-guardrails.md)
- [Durable Background Subagents](./subagents.md)
- [Project Artifacts](./project-artifacts.md)
- [Provider Integration and Cache](./provider-integration.md)
- [Configuration Surfaces](./configuration.md)

[^arch-doc]: repo:///docs/architecture.md
[^product-dir]: repo:///docs/product-direction.md
[^contrib]: repo:///CONTRIBUTING.md
[^agents]: repo:///AGENTS.md
