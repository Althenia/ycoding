# Native Dots connector

## Ownership and transport

Core owns a private `NativeDots.Host` in the server process. Server constructs it in the built global-services context and passes it as the fifth process callback argument. CLI obtains Channels directly from this Host. Native tasks, candidate reads, and decision settlement do not use public HTTP, the browser relay, or an MCP adapter.

Trusted global `dots.enabled: true` and an explicit `dots.profile` select exactly one OpenAI OAuth credential with an account identity. A connection pins its profile, credential ID, account ID, and account generation. Configuration or credential replacement retires that connection and its Channels. Project configuration cannot enable the Host, and selection never falls back to another profile or account.

## Root-family access

Access is persisted as `SessionEvent.DotsAccessChanged`. Existing roots default off. A newly native-created root is enabled in its creation transaction. Children inherit the root's setting; only the root changes it. Missing, deleted, archived, or foreign-owned Sessions have no local access authority.

Local and web clients administer access through these operations only:

| Operation | HTTP | Input | Output |
| --- | --- | --- | --- |
| `session.dots.access.get` | `GET /api/session/:sessionID/dots/access` | Path Session ID | `{ data: { sessionID, rootSessionID, enabled, revision, inherited, configured } }` |
| `session.dots.access.set` | `POST /api/session/:sessionID/dots/access` | `{ enabled, expectedRevision }` | Same access projection |

Setters reject excess authority fields. Revisions are nonnegative integers; a stale revision conflicts. Repeating the same enabled state at the current revision does not increment it. Concurrent writes at one revision commit at most one change. `configured` reports the current trusted profile gate independently of persisted `enabled`.

## Native admission and decisions

Channels carry native source receipts with exact profile, credential, account generation, environment, connection, client, stream, root, access revision, and request identity. Lifetime checks fence asynchronous reads and writes against connection retirement and root-access changes. Managed-child ownership remains parent-only.

Decision candidates bind an exact typed source and revision. Native projection stages single-pick choices rather than granting ambient approval. Permissions, hard/custom guardrails, Forms, Questions, managed-child questions, deferred reviews, and recovery retain their existing typed outcomes and validators. Explicit denies, ceilings, ownership, archive state, and live access are rechecked at settlement. Replaced candidates and retired lifetimes cannot settle. Uncertain mutation outcomes are not replayed.

Prompt text cannot establish a typed decision, native source receipt, or delegation. Ordinary configured external MCP servers, provider tools, and elicitation retain their separate runtime paths.

## Historical readability

Historical Dots and RemoteMCP Session events, source metadata, peer labels, `Dots.DelegationReview`, database tables, and migrations remain readable. Their presence grants no active authority.

Normal queue and steer promotion inspect the stored `DotsExchangeCreated` record. An unpromoted routine or delegated task is rejected transactionally with the existing `DotsInstructionRejected` event and `reason: "delegation_invalid"`, before input preparation or promotion. Repeated promotion emits no duplicate rejection. Historical exchange events remain unchanged; ordinary and native inputs continue normally. No bulk rewrite or data migration occurs.
