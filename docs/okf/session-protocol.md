---
type: Interface
title: Session Protocol and Durable Events
description: V2 session contracts define prompt admission, execution boundaries, instructions,
  tools, restart continuity, and public event-stream semantics across Schema, Protocol,
  and Core.
tags:
- protocol
- events
- session
- contracts
sources:
- id: spec-session
  resource: repo:///specs/v2/session.md
- id: spec-stream
  resource: repo:///specs/v2/event-stream-architecture.md
- id: spec-restart
  resource: repo:///specs/v2/session-restart-continuation.md
- id: spec-tools
  resource: repo:///specs/v2/tools.md
- id: spec-instructions
  resource: repo:///specs/v2/instruction-sync-proposal.md
---

## Prompt Admission and Model Fit

SessionV2.prompt records one durable admitted fact and one pending row before advisory execution; promotion publishes promotion, projects the visible message, and consumes the pending row atomically, while manual compaction uses its own idempotent compact endpoint rather than the pending store.[^spec-session]

Model switching checks rolling context against the target window minus the configured safety margin; an unfitting switch returns 409 without changing durable state and never starts compaction or rewrites transcript rows.[^spec-session]

## Execution, Tools, and Instructions

SessionExecution is process-global and keyed only by Session ID, with Location-scoped runners at drain start and local rules for resume joining, wake coalescing, concurrent sessions, and no-op interruption of unknown or unowned sessions.[^spec-session]

Every started step publishes exactly one terminal ended or failed event; complete local tool calls are durable before side effects, settlement publication remains serialized, and bounded silence or post-output recovery rules prevent unbounded third steps.[^spec-session]

Instruction state uses value deltas plus derived rendering with Session-owned history selection, blob storage, rebuildable fold state, and epoch movement on compaction, movement, or committed revert.[^spec-instructions]

Tool construction, registration, execution, and settlement follow explicit tool laws with validated permission, cancellation, and cleanup boundaries.[^spec-tools]

## Events and Restart

Public events use one encoded feed with independent consumer queues; durable events record facts while projections derive display state and local execution ownership stays separate.[^spec-stream]

Graceful managed-service restart uses private Session suspension with atomic resume consumption; hard-crash recovery and exactly-once provider or tool execution remain out of scope.[^spec-restart]

## Related Concepts

- [Session Execution and Autonomy](./session.md)
- [Session Guardrails](./session-guardrails.md)
- [Durable Background Subagents](./subagents.md)
- [Provider Integration and Cache](./provider-integration.md)

[^spec-session]: repo:///specs/v2/session.md
[^spec-instructions]: repo:///specs/v2/instruction-sync-proposal.md
[^spec-tools]: repo:///specs/v2/tools.md
[^spec-stream]: repo:///specs/v2/event-stream-architecture.md
[^spec-restart]: repo:///specs/v2/session-restart-continuation.md
