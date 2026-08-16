---
type: Workflow
title: Session Execution and Autonomy
description: Sessions provide durable prompt admission, process-local execution, explicit
  autonomy modes, and prompt delivery vocabulary for the coding-agent runtime.
tags:
- session
- execution
- autonomy
- orchestration
sources:
- id: runtime-doc
  resource: repo:///docs/runtime.md
- id: arch-doc
  resource: repo:///docs/architecture.md
- id: product-dir
  resource: repo:///docs/product-direction.md
- id: spec-v2
  resource: repo:///specs/v2/session.md
---

## Durable Admission

A prompt is durably admitted before execution is scheduled. The durable pending row represents unconsumed work only. Promotion into the visible transcript occurs at a safe execution boundary.[^runtime-doc]

Reusing a Session ID adopts the existing session. Reusing a prompt message ID is accepted only for an exact retry with matching session, content, and delivery mode; conflicting reuse fails.[^runtime-doc]

## Execution Ownership

`SessionExecution` is process-global and keyed by Session ID. It uses a process-local coordinator to serialize drains for the same session, join explicit same-session resumes, coalesce advisory wakes, and allow different sessions to execute concurrently.[^runtime-doc]

A drain discovers the session's Location when execution starts. Clustered execution ownership is not yet implemented.[^runtime-doc]

## Steps and Provider Attempts

One step is one logical LLM call with one physical provider attempt. Context-overflow recovery may compact and rebuild the step for one additional attempt. The runtime reloads projected history before durable continuation.[^runtime-doc]

## Prompt Delivery

- **Steer** inputs promote at the next safe step boundary and require the active drain to continue.
- **Queue** inputs remain pending until the session would otherwise become idle.
- Promoting new user input resets the selected agent's step allowance.[^runtime-doc]

## Autonomy Modes

Three explicit modes are supported: `normal` (standard interactive), `yolo` (autonomous under permission policy), and `goal` (repeated continuation toward a durable goal). Goal state stores the goal text, status, iteration, no-progress count, maximum no-progress count, and last progress digest.[^runtime-doc]

Terminal goal states are `completed`, `stopped`, and `exhausted`. A tool-only turn with no assistant text spends an iteration but does not increment the no-progress counter.[^runtime-doc]

## TUI Transcript History

The hot transcript window holds the latest 50 completed messages plus every active or incomplete boundary. Archive page requests use `MESSAGE_PAGE_LIMIT` of 1000. Archived messages render through the same typed transcript components when expanded, and collapsed placeholders retain cursor and page metadata but no transcript payload.[^product-dir]

## Related Concepts

- [Package Architecture](./architecture.md) — session execution is owned by Core, part of the package architecture
- [Session Guardrails](./session-guardrails.md) — guardrails mediate session shell and mutation actions
- [Durable Background Subagents](./subagents.md) — subagents are durable child sessions
- [Provider Integration and Cache](./provider-integration.md) — provider requests execute during session steps
- [Project Artifacts](./project-artifacts.md) — session skills derive from project artifacts

[^runtime-doc]: repo:///docs/runtime.md
[^product-dir]: repo:///docs/product-direction.md
