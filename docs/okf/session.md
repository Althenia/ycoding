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
- id: agents
  resource: repo:///AGENTS.md
---

## Durable Admission

A prompt is durably admitted before execution is scheduled; the pending row represents unconsumed work only and promotion into the visible transcript happens at a safe execution boundary.[^runtime-doc]

Reusing a Session ID adopts the existing session; reusing a prompt message ID is accepted only for an exact retry with matching session, content, and delivery mode, and conflicting reuse fails.[^runtime-doc]

Attachments admitted as URIs are normalized into managed content-addressed references; durable attachment records carry digest, byte count, and managed path, never base64 payloads or source URIs.[^runtime-doc]

Archive and unarchive are reversible Session states that preserve history and leave the last-activity timestamp unchanged; automatic retention deletion is deferred pending cross-process coordination.[^runtime-doc]

## Execution Ownership

SessionExecution is process-global and keyed by Session ID; a process-local coordinator serializes drains for the same session, joins explicit same-session resumes, coalesces advisory wakes, and allows different sessions to run concurrently.[^runtime-doc]

A drain discovers the session Location when execution starts; there is no clustered execution ownership yet and managed-server restart uses private suspension without replaying provider work.[^runtime-doc]

## Steps and Provider Attempts

One step is one logical LLM request; retryable pre-output failures reuse the same logical request ID while each transport start increments its physical-attempt count, and a tool-result continuation is a new logical request.[^runtime-doc]

Every started logical step closes with exactly one durable terminal event; a settled silent response may receive one bounded text-only recovery step with tools disabled, while post-output transport failures close durably and may start one distinct recovery step from reloaded history.[^runtime-doc]

The durable provider-request ledger stores identifiers, model and route identity, stable prompt and cache digests, attempt counts, normalized tokens, cost, continuation mode, and invalidation reason, and never stores prompt, message, tool-result, or response text.[^runtime-doc]

Shell commands have a finite timeout and optional sampled memory limit with a distinct memory-limit terminal status; a foreground command still running after 300 seconds moves to the background without being stopped.[^runtime-doc]

## Prompt Delivery

Steer inputs promote at the next safe step boundary and require the active drain to continue, while queue inputs remain pending until the session would otherwise become idle.[^spec-v2]

Promoting new user input resets the selected agent step allowance; a batch of steers resets it once.[^spec-v2]

## Autonomy Modes

Session autonomy is durable with normal, yolo levels 1-3, and goal modes; yolo 1 auto-answers questions and forms, yolo 2 also auto-approves ask permissions, yolo 3 also auto-approves guardrail reviews, and active goal auto-answers questions and permissions but still requires yolo 3 for guardrails.[^runtime-doc]

Goal mode terminates explicitly as completed, stopped, or exhausted; reports are reserved for unresolved blockers after reasonable self-resolution and each accepted report consumes one no-progress attempt.[^runtime-doc]

TUI subagent indicators rehydrate from durable state after reconnect or restart rather than requiring the user to open each child session.[^agents]

## Compaction and Transcript

Selective compaction is runtime-owned with advisory consider and advised thresholds, a mandatory hard-limit gate, immutable context revisions, and content-addressed manifests; new compaction never deletes canonical history.[^runtime-doc]

Opening a Session fetches its complete current projected transcript in canonical ascending order; completed compaction releases covered resident rows without changing durable history.[^runtime-doc]

Runtime observations for session-state, team-view, and step-limit sources are append-only durable messages rendered as compact summaries.[^runtime-doc]

## Related Concepts

- [Package Architecture](./architecture.md)
- [Session Guardrails](./session-guardrails.md)
- [Durable Background Subagents](./subagents.md)
- [Provider Integration and Cache](./provider-integration.md)
- [Project Artifacts](./project-artifacts.md)

[^runtime-doc]: repo:///docs/runtime.md
[^spec-v2]: repo:///specs/v2/session.md
[^agents]: repo:///AGENTS.md
