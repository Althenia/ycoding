# Projects and coordination

## Ownership and membership

A local Project contains exactly one Master Session and a roster of member root Sessions. It is distinct from repository-derived `Project.ID` and retains a `cgrp_` identifier. Each Session belongs to at most one Project as Master or member. Membership preserves Session IDs, histories, Locations, parentage, agents, models, permissions, and goals. Unknown, archived, and non-root Sessions cannot join. A Project has at most 64 members; its Master is separate from that list.

Schema owns the wire shapes and durable events. Core owns Project storage, membership validation, activation, message admission, notifications, and native delegated decisions. Protocol and Server expose owner-authenticated operations. Session Locations are resolved by the backend, not supplied by Project operations.

## Human operations

| Operation | Method and path | Request | Response |
| --- | --- | --- | --- |
| `coordination.settings` | `GET /api/coordination/settings` | — | Resolved user-level delegated-decision policy |
| `coordination.list` | `GET /api/coordination` | — | Project summaries |
| `coordination.create` | `POST /api/coordination` | `name`, `masterSessionID`, `memberSessionIDs` | Project detail |
| `coordination.get` | `GET /api/coordination/:groupID` | — | Project detail |
| `coordination.update` | `PATCH /api/coordination/:groupID` | `revision`, optional `name`, `masterSessionID`, `memberSessionIDs`, `settings` | Project detail |
| `coordination.delete` | `DELETE /api/coordination/:groupID` | — | 204 No Content |

Data responses use `{ data }`. Revision conflicts and invalid membership are explicit failures. Omitted update fields retain their values. Supplied member lists and settings replace their previous values. Settings contain `concurrency` (positive integer or null) and optional `delegatedDecisions` narrowing. New Projects default to null concurrency and inherited decision policy.

Creating a Session for a Project composes the existing Session create operation with `coordination.update`, or with `coordination.create` for a new Master. Removing a member from a Project uses `coordination.update` and leaves it running with its history intact. Deleting a member Session uses the existing Session delete and removes its membership. Deleting the Master Session deletes its Project. Deleting only the Project preserves all Sessions and their histories.

The CLI operation set is `ycoding coordination list|get|create|update|delete`. Remote operations and Relay MCP use the same coordination-prefixed names, validation, ownership, and backend-resolved Locations. Uncertain mutation outcomes require reconciliation, not an automatic retry with a new identity.

## Activation

A human user message in the Master chat activates the Project. Interrupting the Master, including while idle, pauses it. A backend restart leaves Projects inactive. `pausedReason`, when present on an inactive Project, is `interrupted` or `restart`; activation clears it. Newly created inactive Projects omit it.

While inactive, `send` fails with `Project is inactive; send a message in the master chat to resume`; `answer`, `escalate`, and `interrupt` remain available. Completed and interrupted notifications remain pending in the Master chat without starting a turn until another user message; failures, decision requests, and escalations still wake their receiver. There are no separate arm, stop, complete, lease, or dispatch-queue controls.

## Master tool: `project`

The Master and its subagent descendants receive the `project` tool, scoped to that Master's Project. Other Sessions cannot use it. Masters remain ordinary chat Sessions with their configured tools. Their instructions assign the Master and its supervising subagents a coordination-only role: delegate implementation, code reads and edits, checks and commits to members; react to member events, verify reported evidence, and carry undecidable requests upward with reasons. The Master may direct members itself or assign one or more members to each supervising subagent.

| Action | Input | Output |
| --- | --- | --- |
| `list` | — | Project identity, active state, optional pause reason, concurrency, and members |
| `send` | `sessionID`, `text`, optional `delivery`, `messageID`, `model` | Admitted message ID, member state, and whether an existing admission reconciled |
| `answer` | `sessionID`, `requestID`, `kind`, `fingerprint`, `rationale`, optional native `answer` and `confidence`, optional `decision` (`approve` default, or `decline`) | Native settlement result or visible escalation reason |
| `escalate` | `sessionID`, `requestID`, `kind`, `fingerprint`, `reason` (1–500 characters) | `delivered`, optional notice `messageID`, and `decision` (`outcome`, optional `to: master \| human`, `coordinationEscalation`, `reason`, `reviewItemID`) |
| `interrupt` | `sessionID` | Interrupt result and member state |

`list` returns member titles, recorded Locations, `lastActivity`, live state (`idle`, `running`, `waiting`, `failed`), and pending native request summaries with IDs and fingerprints. `waiting` indicates a question/form, permission request, or review. Optional `drivenBy: { sessionID, title }` identifies the Master subagent that last sent to that member while the subagent is still running.

`send` defaults to `delivery: queue`; `steer` admits input for an active turn. It returns without awaiting member completion. An optional model reference is `{ providerID, id, variant?, profile? }` and applies to the turn the message starts, without changing the member's configured agent or model. Invalid model choices are refused at the target Location.

A supplied `messageID` makes send retries idempotent. The same ID and text reconcile the existing admission; a different text, target, or incompatible existing identity fails. At a configured concurrency limit, sending to an idle member fails with `Project concurrency limit <n> reached`. Active member execution and admitted pending work count toward admission; work is refused, not placed in a Project dispatch queue.

## Provenance and transcript presentation

Member messages are the owner's first-person instruction channel: an outcome, direct actions and checks, exclusions, and a stop/report condition. The `ycoding/coordination-voice` instruction source guides the Master and its subagents. The member transcript renders these as ordinary user messages under TUI rule T55, without a separate sender persona or delegation label.

The backend admits `inputOrigin: coordination` with Project, Master, sender Session, and message identities as audit metadata. Message text cannot become a native control reply or expand authority. Decision statements must be grounded in recorded human instructions or current delegated authority.

## Member notifications

Member turn success, failure, interruption, question/form creation, permission asks, and guardrail reviews create compact synthetic notifications using the existing Session notification mechanism. Token deltas and tool progress do not notify. A deterministic message identity prevents duplicate delivery of the same event.

Notifications go to the Session that last sent to that member if it is a running Master subagent; otherwise they go to the Master. Failure, question/form, permission, review, and escalation notices wake that receiver even while the Project is inactive, without activating it; completed and interrupted notices wake the receiver only while the Project is active and otherwise wait in the Master chat. Notification text starts with `Project notification:` and carries JSON metadata:

```text
{ source: "project_notification", groupID, memberSessionID, title,
  event: "completed" | "failed" | "interrupted" | "question" | "permission" | "review" | "escalated",
  requestID?, excerpt?, kind?, escalatedBy?: { sessionID, title } }
```

The excerpt is at most 500 characters. An `escalated` notice carries the request `kind`, the escalating subagent as `escalatedBy`, and its reason as the excerpt. Notifications contain observations, not authority. The receiver rereads current member state and pending native requests before acting.

## Delegated routine decisions

User-level `coordination.delegated_decisions` enables routine delegation by default. It is centrally configurable and revocable. Project `settings.delegatedDecisions` may only narrow inherited categories, actions, resources, and expiry; it cannot restore globally disabled authority. Every attempt binds the calling Master or subagent, current Project membership and policy, live request identity and fingerprint, and native settlement.

Default routine classes are owner questions/forms answerable from the assignment, approved scope, or a sufficiently certain safest reversible choice; permission asks for reads or writes within the assigned workspace/worktree, approved paths, or the member's own temporary scratch directory; and ordinary in-scope guardrail reviews. Native policy verifies these facts before settlement.

Hard reviews, destructive or irreversible actions, external writes, publication, deployment, releases, purchases, paid spending, credential/account changes, dependency installs/downloads, production migrations, CI/CD changes, public-contract breaks, scope expansion, and low-confidence or conflicting cases always escalate to the human. The policy removes no deny, permission ceiling, or human-only review boundary.

Revalidate global policy, Project narrowing, membership, expiry, request state, queues, and deny/ceiling rules immediately before settlement. Project active state gates only `send`; `answer` (approve or decline), `escalate`, and `interrupt` work while the Project is inactive. Use native decision and validation paths and record the rationale and originating Session in their audit records. Every coordinated permission settlement publishes `permission.replied` with its reply, so clients remove the pending prompt. Native audit fields retain the `coordinator` actor name. Delegation does not enable YOLO, rewrite independent auto flags, or create another evaluator.

`decision: decline` applies to permission asks and ordinary reviews, not questions (`invalid-decision`). It passes the same policy, membership, live-identity, and human-only checks as an approval, then rejects through the native path: the permission records `session.permission.assessed` with outcome `deny`, via `coordination`, reply `reject`, and the coordinator fields, and publishes `permission.replied` with reply `reject`; the review records `guardrail.replied` with reply `reject` and `session.guardrail.decided` with reply `reject` and the coordinator fields. The member receives the rationale as feedback. A decline never rejects a hard review or a human-only request; those return the escalation reason.

Exact repeated decisions reconcile existing settlement; conflicting or stale requests fail. Denies remain denied. Hard reviews and human-only review-box items remain human-owned. Invalid policy, unavailable evaluators, uncertain results, unsupported requests, and new approval boundaries produce a visible escalation reason rather than automatic approval.

## Escalation chain

`escalate` passes a pending member request up one hop with a reason. It requires current Project membership and the live request identity and fingerprint, and it is never blocked by inactive state, delegation policy, or human-only classification. From a Master subagent it goes to the Master as an `escalated` Project notification that wakes the Master even while the Project is inactive, without activating outbound sends; a repeated escalation of the same request by the same caller reuses the notice. From the Master it hands the request to the human: the pending native prompt (permission, review, or question/form) stays open for the human, and a permission handoff also records `session.permission.assessed` with outcome `escalate`, via `coordination`, reason `escalated`, and the Master's reason as rationale. Review and question handoffs record no model-incident or guardrail-escalation event.

Each hop appends `{ sessionID, reason }` to the request's optional `coordinationEscalation.reasons`, in order, at most four; an identical reason from the same Session reconciles, and a fifth reason returns `escalation-chain-full` without changing the chain, a `to` hop, a notice, or a handoff audit. The field appears on `Permission.Request`, `Guardrail.Request`, and `Form.Info`, does not change the request fingerprint, and is published to clients by the ephemeral `coordination.request.escalated` event `{ sessionID, rootSessionID?, kind, requestID, coordinationEscalation }`. Entering sleep defers the pending request to the review box with the chain on its `permission`, `guardrail`, or `form` payload, with reasons redacted like other payload text. When the request was already deferred to the review box, `escalate` appends nothing and returns `outcome: escalated`, reason `deferred-to-review-box`, the open item's `reviewItemID`, and the chain recorded on its payload, without a `to` hop or notice; the human decides that item through `session.review.decide`, and no coordination path settles it. A stale identity returns `stale` and appends nothing.

## Notification filtering

Filters are client preferences, not Project settings: TUI configuration, web per-browser preferences, and phone push subscription preferences. The phone column remains `coordination_filter`. Persisted `coordinator` terminology in filter values denotes Masters.

Default all-source behavior preserves existing focus, root, category, and permission rules. Optional Master-only or selected-Master filtering applies at external notification/sound delivery. Selection uses durable Master identities, not names. Categories are questions/forms, permissions, reviews, failures, and completion.

Filtering hides no in-app history, pending controls, or human review-box entries and settles no requests. Quota and machine-level notifications retain their separate policy. Unknown source state never replaces an explicit selection with all sources. Existing delivery identities remain responsible for deduplication.

TUI, web-system notifications, and phone Web Push use the same Master selection and category meanings. Phone delivery evaluates persisted subscription filters against Master identities supplied by the authenticated backend. A browser-supplied filter cannot make an unverified Session a Master. Restricted scopes require the source itself to be a verified Master; membership and saved selection IDs do not confer that identity. An unreadable Master list withholds restricted delivery without changing the saved filter.
