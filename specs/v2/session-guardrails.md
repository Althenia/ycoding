# Session guardrails

Status: **Implemented**

Session guardrails are a Location-scoped safety service whose decisions apply to one durable root Session and every descendant Session in that family. They are independent from agent tool permissions and shell sandboxing.

## Ownership

- Schema owns rule, request, reply, counter, status, and ephemeral event shapes.
- Core owns standard policy, custom-rule discovery, matching, family resolution, pending reviews, and counters.
- Protocol and Server expose status, pending requests, and `once | always | reject` replies through Session-location middleware.
- TUI owns rehydrated review queues, parent-view handling of child requests, review interaction, and sidebar status.

## Evaluation contract

Every guarded side-effect boundary submits:

- the acting Session ID;
- an action identifier;
- one or more normalized resources;
- bounded metadata when required for classification.

Core resolves the durable root Session by following parent IDs. Pending reviews and concurrency counters are keyed by that root ID, while the request retains the acting child Session ID for attribution.

The decision order is:

1. an unoverrideable standard catastrophic deny;
2. the first matching custom source layer: nearest repository `Config.Directory`, then broader repository directories, then global config;
3. standard mandatory review;
4. standard allow fallback.

Within one custom source layer, rules sort by descending numeric priority, then deterministic lexical file path and rule ID. An enabled invalid source layer reviews mutation actions with `configuration.invalid` while preserving that layer's priority. Read-only actions remain available, and a valid matching deny in that layer remains a deny.

## Guarded boundaries

The current runtime evaluates guardrails immediately before supported side effects:

- model-facing shell and direct Session shell;
- edit, write, and patch commits;
- durable subagent creation;
- mutation-capable or process-like MCP execution;
- project-artifact mutation.

A permission approval cannot bypass a guardrail decision. A guardrail approval cannot widen the agent's effective permission policy.

## Human review

A review request blocks the guarded operation until the user replies:

- `once` permits that operation attempt;
- `always` permits the attempt and records a transient reusable approval;
- `reject` fails the blocked operation.

An `always` approval is keyed by root Session family, action, ordered matched rule IDs, ordered resources, and request metadata. It is held only by the Location service in process memory, is cleared at service shutdown, is not durable or global, and is shared by descendants of the same root. Core always performs a fresh evaluation before consulting the key: a deny, changed match, or non-review result cannot reuse an approval. `once` is not reusable. `yolo`, `goal`, and TUI permission auto-approval never answer guardrail reviews.

Parent Session views may answer reviews created by descendants in the same root family. An unrelated Session receives a not-found response.
The first valid reply atomically claims the pending request. A concurrent or later reply receives a not-found response and cannot change the winning decision or create a reusable approval.

## Counters

The implemented family caps are:

- concurrently running shells;
- concurrently running subagents;
- pending human reviews.

Reservations are acquired before the side effect and released after success, failure, cancellation, interruption, or service shutdown. Configuration accepts only these implemented caps.

## Custom policy files

Core scans direct `guardrails/*.md` children, not a recursive tree, under the global config directory and every discovered repository `Config.Directory`. Each enabled file defines one validated rule in YAML frontmatter; its Markdown body is operator-facing explanation and is not model instruction. Disabled files are ignored.

Repository directories are evaluated nearest first, then broader ancestors, and global config is last. The first matching source layer decides. Standard catastrophic denies cannot be weakened by custom policy. A malformed enabled source layer is reported in status and fails mutation actions closed with review at that source layer's position; it does not erase or reorder other layers.

## API and events

The public operations are:

```text
GET  /api/session/:sessionID/guardrail
GET  /api/session/:sessionID/guardrail/request
POST /api/session/:sessionID/guardrail/request/:requestID/reply
```

Guardrail asked, replied, and decided events are ephemeral. Durable Session history remains the authority for Session ownership; guardrail review state is process-local and rehydrated from the canonical request API after reconnect or restart.

The Reply body is the public union `once | always | reject`. No new guardrail route is introduced.

## Notification contract

After a 500 ms pending-review checkpoint, an unresolved guardrail review emits **Guardrail approval needed** for root-family ownership and title. The root system notification is blurred-only and uses the `permission` sound. Resolution before the checkpoint suppresses the episode.

## Security invariants

- Catastrophic direct shell forms are denied before process creation.
- Catastrophic standard denies cannot be overridden by custom policy or any approval reply.
- Raw custom file content and command history are not rendered in the sidebar.
- Invalid enabled policy never silently disables the standard profile.
- `always` approvals are exact-match, root-family, Location-service/process-memory state and are checked only after fresh evaluation still asks.
- Descendants cannot escape root-family policy or counters.
