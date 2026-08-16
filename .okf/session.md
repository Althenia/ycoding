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

One step is one logical LLM request. Retryable pre-output failures reuse the same logical request ID; each transport start increments its physical-attempt count. A tool-result continuation is a new logical request. Context-overflow recovery completes the old request as a fallback, compacts the context, and rebuilds a new logical request.[^runtime-doc]

The durable provider-request ledger stores identifiers, model and route identity, stable prompt/cache digests, attempt counts, normalized tokens, cost, continuation mode, and invalidation reason. It does not store prompt, message, tool-result, or response text.[^runtime-doc]

The runtime reloads projected history before durable continuation. It does not delegate V2 orchestration to a legacy in-memory prompt loop.[^runtime-doc]

## Helper Model Traffic

Session titles and goal text are local by default: local title generation selects one sanitized line from the first user prompt and makes no provider request; local goal synthesis collapses whitespace without changing the request's meaning and makes no provider request. Model-generated title and goal behavior requires explicit `efficiency` modes. Compaction remains model-based.[^runtime-doc]

Model-based helpers resolve the hidden agent's explicit model first, then `efficiency.helper_model`, then the current Session model. Helper provider requests use the same content-free request ledger as normal Session steps.[^runtime-doc]

## Stable Tool Prefix

The provider sees one fixed `execute` tool definition describing the restricted JavaScript language and the search-first workflow. It does not embed the current MCP or plugin tool catalog. Connecting, disconnecting, or refreshing an MCP server therefore does not change the provider-visible `execute` schema or the prompt-cache tool digest.[^runtime-doc]

MCP server instruction blocks are sorted by server ID, normalized to LF line endings, stripped of trailing whitespace, and limited to 2,048 UTF-8 bytes per server with an explicit truncation marker.[^runtime-doc]

## Provider Prompt Caching

The cache policy revision is part of the prompt-cache namespace. The process-local cache runtime tracks provider-reported read and write usage by stable namespace. Two reusable observations within five minutes promote later requests for an extended-TTL-capable model to one hour. Missing telemetry, stale observations, namespace rotation, and unsupported model profiles remain at five minutes. The state is bounded, non-durable, and never required to reconstruct a Session.[^runtime-doc]

Direct OpenAI Chat and Responses requests on GPT-5.6 and later use explicit breakpoints by default under `openai_mode: "auto"`. Older direct OpenAI models remain implicit, while compatible gateways and unsupported families omit the explicit fields. Model-based title, goal, and compaction calls use the same policy and observation runtime as normal Session steps.[^runtime-doc]

## OpenAI Responses Continuation

Same-turn OpenAI Responses continuation is process-local and opt-in through effective provider storage. The runtime never turns on `store` to obtain continuation.[^runtime-doc]

A stored response can be reused only when the Session execution, route, model, prompt-cache namespace, system digest, tool digest, and semantic request-options digest all match. The next request sends `previous_response_id` plus only the message suffix after the represented response boundary; current system instructions and tools are always sent again.[^runtime-doc]

Continuation state is cleared when the execution ends, is interrupted, compacts, is deleted, or changes fingerprint. Response IDs are not written to Session history, request diagnostics, or the durable provider-request ledger. If a continued request fails before observable output with an invalid-request error, the runtime clears the response state and retries the same logical request once with full history. A second failure follows the normal provider-error path.[^runtime-doc]

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
