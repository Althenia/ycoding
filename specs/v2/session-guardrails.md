# Session guardrails

Status: **Implemented**

Session guardrails are a Location-scoped safety service whose decisions apply to one durable root Session and every descendant Session in that family. They are independent from agent tool permissions and shell sandboxing.

## Ownership

- Schema owns rule, request, reply, counter, status, and ephemeral event shapes.
- Core owns standard policy, custom-rule discovery, matching, family resolution, pending reviews, and counters.
- Protocol and Server expose status, pending requests, and one-time replies through Session-location middleware.
- TUI owns rehydrated review queues, parent-view handling of child requests, review interaction, and sidebar status.

## Evaluation contract

Every guarded side-effect boundary submits:

- the acting Session ID;
- an action identifier;
- one or more normalized resources;
- bounded metadata when required for classification.

Core resolves the durable root Session by following parent IDs. Pending reviews and concurrency counters are keyed by that root ID, while the request retains the acting child Session ID for attribution.

The decision order is:

1. standard catastrophic deny;
2. matching custom deny;
3. standard mandatory review;
4. invalid enabled custom configuration for a mutation action;
5. matching custom review;
6. matching custom allow;
7. allow fallback.

Custom rules are sorted by descending priority, then by their lexically discovered file order.

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
- `reject` fails the blocked operation.

There is no persistent guardrail approval. `yolo`, `goal`, and TUI permission auto-approval never answer guardrail reviews.

Parent Session views may answer reviews created by descendants in the same root family. An unrelated Session receives a not-found response.

## Counters

The implemented family caps are:

- concurrently running shells;
- concurrently running subagents;
- pending human reviews.

Reservations are acquired before the side effect and released after success, failure, cancellation, interruption, or service shutdown. Configuration accepts only these implemented caps.

## Custom policy files

Core loads `~/.config/ycoding/guardrails/*.md` in lexical order. Each enabled file defines one validated rule in YAML frontmatter. Disabled files are ignored. Malformed enabled files are reported in status and force mutation actions to human review; read-only actions remain available.

Standard catastrophic denies cannot be weakened by custom policy.

## API and events

The public operations are:

```text
GET  /api/session/:sessionID/guardrail
GET  /api/session/:sessionID/guardrail/request
POST /api/session/:sessionID/guardrail/request/:requestID/reply
```

Guardrail asked, replied, and decided events are ephemeral. Durable Session history remains the authority for Session ownership; guardrail review state is process-local and rehydrated from the canonical request API after reconnect or restart.

## Security invariants

- Catastrophic direct shell forms are denied before process creation.
- Raw custom file content and command history are not rendered in the sidebar.
- Invalid enabled policy never silently disables the standard profile.
- Reviews expose only one-time approval and rejection.
- Descendants cannot escape root-family policy or counters.
