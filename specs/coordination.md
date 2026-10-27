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

The CLI operation set is `ycoding coordination list|get|create|update|delete`. Browser relay operations use the same coordination-prefixed names, validation, ownership, and backend-resolved Locations. Uncertain mutation outcomes require reconciliation, not an automatic retry with a new identity.

## Activation

A human user message in the Master chat activates the Project. Interrupting the Master, including while idle, pauses it. A backend restart leaves Projects inactive. `pausedReason`, when present on an inactive Project, is `interrupted` or `restart`; activation clears it. Newly created inactive Projects omit it.

While inactive, `send` fails with `Project is inactive; send a message in the master chat to resume`; `answer`, `escalate`, and `interrupt` remain available. Routine notifications remain pending in the recorded owner's chat without starting an execution; failures, decision requests, and escalations still wake their receiver. There are no separate arm, stop, complete, lease, or dispatch-queue controls.

## Master tool: `project`

The persisted Master and Sessions recorded as owners of at least one member receive the `project` tool. Executor children inherit no controller authority. `Coordination.accessOf` supplies the role and ownership scope used by tool availability, native authorization, recipient routing, and generated role instructions. Sessions outside a Project retain their configured behavior and tools.

Each member has an optional `owner_session_id` referencing a Session with `ON DELETE SET NULL`. Existing members retain null ownership; no historical owner is inferred. A null owner routes events and requests to the Master. The Master may explicitly own a member or assign it to a managed child it launched. Only the Master assigns or transfers ownership. The Master or current recorded owner releases it with reason `completed` or `released`. Idling, failure, interruption, and execution settlement do not release ownership. Membership removal releases it; other membership edits retain surviving owners. Replacing the Master clears assignments from the former controller family. Public participants expose optional `owner: { sessionID, title }` independently of transient `drivenBy` state.

| Action | Input | Output |
| --- | --- | --- |
| `list` | — | Project identity, active state, optional pause reason, concurrency, and members |
| `inspect` | `sessionID`, `requestID` | Current pending request identity, bounded redacted action/resources or question fields, review rules and flags, escalation reasons, and `delegation`: `routine`, `decline-only`, `escalate`, or `human-only:<reason>`; metadata and tool descriptions are excluded |
| `send` | `sessionID`, `text`, optional `delivery`, `messageID`, `model` | Admitted message ID, member state, and whether an existing admission reconciled |
| `answer` | `sessionID`, `requestID`, `kind`, `fingerprint`, `rationale`, optional native `answer` and `confidence`, optional `decision` (`approve` default, or `decline`) | Native settlement result or visible escalation reason |
| `escalate` | `sessionID`, `requestID`, `kind`, `fingerprint`, `reason` (1–500 characters) | `delivered`, optional notice `messageID`, and `decision` (`outcome`, optional `to: master \| human`, `coordinationEscalation`, `reason`, `reviewItemID`) |
| `interrupt` | `sessionID` | Interrupt result and member state |
| `assign` | `sessionID`, `ownerSessionID` | Recorded owner; Master-only assignment or transfer |
| `release` | `sessionID`, `reason: completed \| released` | Cleared ownership; Master or current owner only |

`list` returns member titles, recorded Locations, `lastActivity`, live state (`idle`, `running`, `waiting`, `failed`), and pending native request summaries with IDs and fingerprints. `waiting` indicates a question/form, permission request, or review. Optional `drivenBy: { sessionID, title }` identifies the Master subagent that last sent to that member while the subagent is still running.

`send` defaults to `delivery: queue`; `steer` admits input for an active turn. It returns without awaiting member completion. An optional model reference is `{ providerID, id, variant?, profile? }` and applies to the turn the message starts, without changing the member's configured agent or model. Invalid model choices are refused at the target Location.

A supplied `messageID` makes send retries idempotent. The same ID and text reconcile the existing admission; a different text, target, or incompatible existing identity fails. Reconciliation requires current authority: a former owner cannot reuse an admitted identity after transfer. At a configured concurrency limit, sending to an idle member fails with `Project concurrency limit <n> reached`. Active member execution and admitted pending work count toward admission; work is refused, not placed in a Project dispatch queue.

Transfers, membership changes, member controls, and event delivery serialize through one process-local Project ownership fence. Controls admitted before transfer complete under their original ownership; later controls recheck the recorded owner. Delivered history remains immutable. Pending requests retain native identities and are handed to the current owner with deterministic notice identities. Late events route to the owner current at delivery, and stale owner-change notifications cannot redirect them. Restart retains ownership while leaving the Project inactive. Role instruction updates revoke controller guidance when ownership ends.

## Provenance and transcript presentation

Member messages are the owner's first-person instruction channel: an outcome, direct actions and checks, exclusions, and a stop/report condition. The `ycoding/coordination-voice` instruction source guides the Master and its subagents. The member transcript renders these as ordinary user messages under TUI rule T55, without a separate sender persona or delegation label.

The backend admits `inputOrigin: coordination` with Project, Master, sender Session, and message identities as audit metadata. Message text cannot become a native control reply or expand authority. Decision statements must be grounded in recorded human instructions or current delegated authority.

## Member notifications

Member execution start, settled logical-step progress, success with no unfinished background work in the member's family, failure, interruption, question/form creation, permission asks, and guardrail reviews create compact synthetic notifications using the existing Session notification mechanism. Running descendants, active child tasks, undelivered task notices, and outstanding or running jobs prevent completion notification. Token deltas and tool progress do not notify. A deterministic message identity prevents duplicate delivery of the same event.

Notifications go directly to the recorded owner, including an idle owner, or to the Master when ownership is null. Supervisor-owned members do not duplicate routine notices to the Master. Failure, question/form, permission, review, and escalation notices wake that receiver even while the Project is inactive, without activating it; other notices wake the receiver only while the Project is active and otherwise wait in the owner's chat. Notification text starts with `Project notification:` and carries JSON metadata:

```text
{ source: "project_notification", groupID, memberSessionID, title,
  event: "started" | "progress" | "completed" | "failed" | "interrupted" | "question" | "permission" | "review" | "escalated",
  requestID?, excerpt?, kind?, escalatedBy?: { sessionID, title } }
```

The excerpt is at most 500 characters. An `escalated` notice carries the request `kind`, the escalating subagent as `escalatedBy`, and its reason as the excerpt. Notifications contain observations, not authority. The receiver rereads current member state and pending native requests before acting.

Startup recovers retained execution and settled-Step notifications only from the member's current membership interval. It uses the current owner and existing notice identity without waking either Session or replaying work. Events before joining or while outside the Project are excluded.

## Delegated routine decisions

User-level `coordination.delegated_decisions` enables routine delegation by default. It is centrally configurable and revocable. Project `settings.delegatedDecisions` may only narrow inherited categories, actions, resources, and expiry; it cannot restore globally disabled authority. Every attempt binds the calling Master or subagent, current Project membership and policy, live request identity and fingerprint, and native settlement.

Default routine classes are owner questions/forms, permission asks for reads or writes within the assigned workspace/worktree, approved paths, or the member's own temporary scratch directory, and ordinary in-scope guardrail reviews. Native policy verifies these facts before settlement. The effective category mode remains authoritative for approvals, declines, and answers: Manual requires a human, so a coordinator approval escalates without settling and `decision: decline` escalates with reason `human-only:manual-permissions` or `human-only:manual-guardrails`, also without settling; Auto uses only its deterministic rules, with answers restricted to valid explicit defaults or exactly one Recommended option; YOLO uses the category's hidden evaluator. A proposed coordinator answer cannot widen that mode or supply generated free text outside the YOLO answer path.

Hard reviews, destructive or irreversible actions, external writes, publication, deployment, releases, purchases, paid spending, credential/account changes, dependency installs/downloads, production migrations, CI/CD changes, public-contract breaks, scope expansion, and low-confidence or conflicting cases always escalate to the human. The policy removes no deny, permission ceiling, or human-only review boundary.

Revalidate global policy, Project narrowing, membership, expiry, request state, queues, and deny/ceiling rules immediately before settlement. Project active state gates only `send`; `answer` (approve or decline), `escalate`, and `interrupt` work while the Project is inactive. Use native decision and validation paths and record the rationale and originating Session in their audit records. Every coordinated permission settlement publishes `permission.replied` with its reply, so clients remove the pending prompt. Native audit fields retain the `coordinator` actor name. Delegation does not change any category's autonomy mode or create another evaluator.

`decision: decline` applies to permission asks and ordinary reviews, not questions (`invalid-decision`). It passes the same policy, ownership, membership, live-identity, and human-only checks as an approval. An ordinary unclassified permission ask or standard ordinary review can be declined without a routine action classification; an unclassified custom-rule review still escalates with `unknown-semantics`. Native rejection records `session.permission.assessed` with outcome `deny`, via `coordination`, reply `reject`, and the coordinator fields, and publishes `permission.replied` with reply `reject`; reviews record `guardrail.replied` with reply `reject` and `session.guardrail.decided` with reply `reject` and coordinator fields. The member receives the rationale as feedback. Hard reviews, human-only requests, and requests whose effective category mode is Manual remain human-owned.

Exact repeated decisions reconcile existing settlement; conflicting or stale requests fail. Denies remain denied. Hard reviews and human-only review-box items remain human-owned. Invalid policy, unavailable evaluators, uncertain results, unsupported requests, and new approval boundaries produce a visible escalation reason rather than automatic approval.

## Escalation chain

`escalate` passes a pending member request up one hop with a reason. It requires current Project membership and the live request identity and fingerprint, and it is never blocked by inactive state, delegation policy, or human-only classification. From a Master subagent it goes to the Master as an `escalated` Project notification that wakes the Master even while the Project is inactive, without activating outbound sends; a repeated escalation of the same request by the same caller reuses the notice. From the Master it hands the request to the human: the pending native prompt (permission, review, or question/form) stays open for the human, and a permission handoff also records `session.permission.assessed` with outcome `escalate`, via `coordination`, reason `escalated`, and the Master's reason as rationale. Review and question handoffs record no model-incident or guardrail-escalation event.

Each hop appends `{ sessionID, reason }` to the request's optional `coordinationEscalation.reasons`, in order, at most four; an identical reason from the same Session reconciles, and a fifth reason returns `escalation-chain-full` without changing the chain, a `to` hop, a notice, or a handoff audit. The field appears on `Permission.Request`, `Guardrail.Request`, and `Form.Info`, does not change the request fingerprint, and is published to clients by the ephemeral `coordination.request.escalated` event `{ sessionID, rootSessionID?, kind, requestID, coordinationEscalation }`. Entering sleep defers the pending request to the review box with the chain on its `permission`, `guardrail`, or `form` payload, with reasons redacted like other payload text. When the request was already deferred to the review box, `escalate` appends nothing and returns `outcome: escalated`, reason `deferred-to-review-box`, the open item's `reviewItemID`, and the chain recorded on its payload, without a `to` hop or notice; the human decides that item through `session.review.decide`, and no coordination path settles it. A stale identity returns `stale` and appends nothing.

## Notification filtering

Filters are client preferences, not Project settings: TUI configuration, web per-browser preferences, and phone push subscription preferences. The phone column remains `coordination_filter`. Persisted `coordinator` terminology in filter values denotes Masters.

Default all-source behavior preserves existing focus, root, category, and permission rules. Optional Master-only or selected-Master filtering applies at external notification/sound delivery. Selection uses durable Master identities, not names. Categories are questions/forms, permissions, reviews, failures, and completion.

Filtering hides no in-app history, pending controls, or human review-box entries and settles no requests. Quota and machine-level notifications retain their separate policy. Unknown source state never replaces an explicit selection with all sources. Existing delivery identities remain responsible for deduplication.

TUI, web-system notifications, and phone Web Push use the same Master selection and category meanings. Phone delivery evaluates persisted subscription filters against Master identities supplied by the authenticated backend. A browser-supplied filter cannot make an unverified Session a Master. Restricted scopes require the source itself to be a verified Master; membership and saved selection IDs do not confer that identity. An unreadable Master list withholds restricted delivery without changing the saved filter.

## Verification

- `packages/core/test/coordination-assignment.test.ts` and `coordination-runtime.test.ts` enforce ownership, transfer ordering, stale-owner refusal, native delivery, deduplication, and restart recovery.
- `packages/core/test/coordination-model-request.test.ts`, `coordination-hierarchy-prompt.test.ts`, and the native decision suites enforce role/tool consistency, ordinary-Session behavior, and permission, question, and review boundaries.
- `packages/core/test/database-migration.test.ts` and `packages/core/script/migration.test.ts` enforce populated upgrades, null ownership, deletion actions, and identical fresh/upgraded constraints and indexes. The migration generator's `--check` validates generated schema and registry consistency.
- `packages/schema/test/coordination.test.ts` and `event-manifest.test.ts` enforce wire shapes and event inventory. TUI Projects-tab, flow, and picker render tests enforce the displayed owner context and keyboard paths.
