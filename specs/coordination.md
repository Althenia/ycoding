# Projects and coordination

## Ownership

The Projects screen manages coordination groups: local-backend objects distinct from repository-derived `Project.ID`. A group contains one coordinator root and an explicit roster of worker or observer roots. Existing Sessions retain their IDs, histories, Locations, parentage, goals, and permissions. Group membership does not grant filesystem, provider, credential, or autonomy authority.

Schema owns the wire shapes and durable events. Core owns group storage, leases, wait cursors, dispatch receipts, role restrictions, and runtime admission. Protocol and Server expose owner-authenticated local operations. The CLI and TUI consume the local API. Web and phone clients use the closed remote operation set through the authenticated relay. Relay MCP exposes the same coordination operations and validation without a separate authority path.

## Roles and assignments

- A coordinator inspects state, records dependencies, delegates bounded execution, evaluates returned evidence, and uses permitted native decision paths. It does not execute implementation tools.
- A worker executes only its explicitly assigned tools and resource scope. Subdelegation requires explicit authority and retains existing nesting, capacity, permission, and guardrail gates.
- An observer reads group state without claiming workers, dispatching, or deciding requests.

Role limits are enforced during tool advertisement and invocation, not only by prompt text. Role rules restrict existing authority and never override a deny. A group has at most 64 roster entries and exactly one coordinator. Unknown, archived, or non-root Sessions are ineligible. Targets and tool execution resolve their recorded backend Locations; input does not select a replacement directory.

## Writer leases

At most one active coordinating writer owns a target root across all groups. Claims carry the holder Session, target Session, fencing generation, and expiry. Acquiring, renewing, releasing, and revoking claims preserve optimistic group revisions. Dispatch revalidates the claim at admission; a stale generation cannot write after expiry, reassignment, roster removal, or stop.

Lease expiry does not cancel an independent worker. It prevents additional coordination writes. Reacquiring a target creates a new fencing generation.

## Capacity

Group policy specifies positive concurrency or null for no additional policy cap, a bounded queue capacity, and an optional spend budget. Null does not disable the runtime's hard limits. Read models distinguish requested policy, effective capacity, active work, dependency waiting, queued work, remaining budget, and the constraint blocking admission.

Capacity reservations and queue admission are atomic. Queues contain at most 1,000 entries. Freeing capacity reevaluates eligible queued dispatches without polling. Waiting remains outstanding work, even when it uses no model-execution slot. Creating more root Sessions is not a capacity bypass.

## Dispatch and provenance

Active master Sessions receive the `ycoding/coordination-voice` instruction source. Worker messages are the owner's first-person instruction channel, with an outcome, required actions and checks, excluded work, and a stop/report condition. The transcript presents no separate sender persona, delegation label, or originating master Session ID. Existing message bodies are not rewritten.

Decision statements must be grounded in recorded human instructions or current delegated authority. The originating Session ID and authenticated transport provenance remain audit metadata for source validation and duplicate reconciliation. Message text cannot settle a permission, guardrail, or review control or expand delegated authority; those controls settle only through their native paths.

A dispatch records a stable dispatch ID, group, originating Session, target, generation, bounded instruction, execution selection, dependencies, allowed tools, and resource scope. A dispatch may depend on at most 32 earlier dispatches. Only satisfied dependencies and current capacity permit admission.

The target pending input and admitted receipt commit in one event transaction. An exact retry reconciles the original dispatch and input identity without replacing its execution choice; conflicting identity reuse fails. The receipt distinguishes queued, pending, admitted, failed, cancelled, and completed work. Unknown outcomes are reconciled before another action; a new input ID must not replay an uncertain mutation.

A claim or execution selection that fails admission revalidation produces a failed receipt without admitting input. The failed dispatch releases its capacity and does not block later eligible work. Interruption, uncertain input publication, and unrelated conflicts retain their native outcomes.

The backend constructs `inputOrigin: coordination` and the group, originating Session, dispatch, and fencing provenance as audit metadata. Arbitrary text or caller metadata cannot forge this channel or become a native control reply. Decision context retains the authenticated channel origin independently from message presentation. Native Session prompt admission and execution remain separate; the existing Session runner executes admitted work at the target's recorded Location.

Only a verified runtime work-completion receipt completes its dispatch. An idle transition alone does not. Failure and interruption retain their native outcomes. Group stop does not withdraw admitted input or cancel workers.

### Execution selection

Each dispatch requires `selection: { agent, model, reason }`. `model` is the canonical provider/model reference with its optional named profile and variant. `reason` is one nonblank line of at most 500 characters. The target Location must expose the configured agent, model, profile, and variant. A model advertising variants requires an explicit supported choice; a model advertising none has no explicit variant. Unsupported or unavailable selections fail closed rather than inheriting or substituting defaults.

An active dispatch does not use configured `model_fallbacks`. Model-resolution and provider failures retain their native outcome on the selected model. Ordinary Session execution retains its configured fallback behavior.

Choose ownership for the assignment rather than using a fixed root profile:

| Root owner | Assignment |
| --- | --- |
| `god` | Coordinate independent workstreams with explicit ownership. |
| `architech` | Retain design decisions and integration across package boundaries. |
| `GSD` | Deliver bounded changes and repairs. |
| `yangi` | Carry one focused assignment under one owner. |

| Worker | Assignment |
| --- | --- |
| `wittgenstein` | Track state and relay settled information. |
| `occam` | Make small, minimal edits. |
| `omoikane` | Design and implement with system context. |
| `zeus` | Implement complex work from verified evidence. |

Use the exact configured agent ID for the chosen profile. Assess size, difficulty, and risk before choosing effort: `low` for mechanical tracking, `medium` for routine work, and `high` or `xhigh` for complex work. Use `max` only when a concrete need cannot be covered at lower effort. These are task-fit guidelines, not an assertion that every provider offers those variant names.

Persist the selected agent, model reference, and one-line reason once with the dispatch. Every dispatch receipt projects that selection, including queued and terminal outcomes. The choice applies only to the target's active promoted assignment. It does not replace the Session's configured agent or model, propagate an execution override to descendants, or confer permission authority. A later human input or settled assignment restores ordinary Session selection.

The existing `subagent` launch contract remains independent: its model override is optional and it has no required selection-reason field. Coordination receipt requirements apply to coordination dispatches.

## Event waits

A coordinator may wait only on its assigned control Sessions. Each wait has a stable ID, roster revision, bounded target set, cursor state, lifetime, and result limit. Lifetimes are at most 300 seconds and each result contains at most 200 observations.

Relevant observations include Session state changes, failures, questions/forms, permission asks, guardrail state, and verified completion. Token deltas and unstructured tool progress do not wake coordination. Observations include source identity, event identity, sequence, type, and occurrence time. They contain no decision authority.

Registering a wait and establishing its initial watermark must not lose an intervening event. Duplicate delivery is idempotent. Reconnect replays from durable cursors. A changed source epoch or missing retained range returns an explicit gap requiring current-state reconciliation. Cancellation, expiry, roster removal, group stop, and claim loss close affected waits.

The runtime uses shared event subscriptions and indexed wait records, not one persistent monitor per Session. No polling loop, idle model call, or sleep wake-up is needed. After any observation, reread current Session state, queued input, pending native requests, group revision, and ownership before acting.

## Delegated routine decisions

User-level `coordination.delegated_decisions` enables routine delegation by default for every group. It is centrally configurable and revocable. A group's optional policy can only narrow the inherited categories, actions, resources, and expiry; it cannot restore globally disabled authority. Every attempt binds the coordinator and target, current policy revision, live request identity and fingerprint, and native settlement.

Default routine classes are owner questions/forms answerable from the assignment, approved scope, or a sufficiently certain safest reversible choice; permission asks for reads or writes within the assigned workspace/worktree, approved paths, or the worker's own temporary scratch directory; and ordinary in-scope guardrail reviews. The native policy path verifies those facts before settlement.

Hard reviews, destructive or irreversible actions, external writes, publication, deployment, releases, purchases, paid spending, credential or account changes, dependency installs/downloads, production migrations, CI/CD changes, public-contract breaks, scope expansion, and low-confidence or conflicting cases always escalate to the human. The global policy does not remove any deny, permission ceiling, or human-only review boundary.

Revalidate the global policy, group narrowing, ownership, expiry, request state, queues, and deny/ceiling rules immediately before settlement. Use the existing native decision and validation paths; record the rationale and coordinator audit receipt. A delegation policy does not enable YOLO or rewrite any independent auto flag and does not create another evaluator.

Record the originating Session, delegated policy, and bounded rationale in the native audit receipt. Do not turn instruction-channel text into a native human reply. Exact repeated decisions reconcile an existing settlement; conflicting or stale requests fail. Denies remain denied. Actual hard reviews and human-only review-box items remain human-owned. A new approval boundary, invalid policy, unavailable evaluator, uncertain result, or unsupported request produces a visible escalation reason rather than automatic approval.

## Lifecycle

Groups expose disarmed, armed, waiting, stopped, completed, and needs-rearm states. Human controls create, edit policy/roster, arm, stop, and complete a group. Coordinators cannot self-arm or change their own authority through the agent tool.

Stopping prevents new dispatch, ends waits, and releases claims. Workers and their admitted work continue independently. Restart marks previously active groups needs-rearm and requires explicit human re-arm; recovery never resumes root execution or replays tools. Completion requires terminal dispatches, satisfied dependencies, and no outstanding group work or human-only review. Dependency waiting does not consume goal no-progress attempts or rewrite any Session goal.

## Local API

Every operation requires the existing owner-authenticated local Server connection. Group operations accept no Location selector. Mutations use the current group revision where applicable. Actor identity is constructed at the trusted Server or tool boundary, never accepted as an arbitrary request object.

| Operation | Method and path |
| --- | --- |
| `coordination.settings` | `GET /api/coordination/settings` |
| `coordination.list` | `GET /api/coordination` |
| `coordination.create` | `POST /api/coordination` |
| `coordination.get` | `GET /api/coordination/:groupID` |
| `coordination.members` | `PUT /api/coordination/:groupID/members` |
| `coordination.arm` | `POST /api/coordination/:groupID/arm` |
| `coordination.stop` | `POST /api/coordination/:groupID/stop` |
| `coordination.complete` | `POST /api/coordination/:groupID/complete` |
| `coordination.claim` | `POST /api/coordination/:groupID/claim` |
| `coordination.release` | `POST /api/coordination/:groupID/release` |
| `coordination.dispatch` | `POST /api/coordination/:groupID/dispatch` |
| `coordination.receipts` | `GET /api/coordination/:groupID/receipts` |
| `coordination.wait` | `POST /api/coordination/:groupID/wait` |
| `coordination.cancelWait` | `POST /api/coordination/:groupID/wait/cancel` |
| `coordination.capacity` | `GET /api/coordination/:groupID/capacity` |

Responses wrap their data in `data`. Group detail includes bounded claim and dispatch views. Validation and revision conflicts are explicit failures; uncertain transport outcomes are not proof that a mutation failed.

`coordination.members` updates the roster, optional bounded name, and optional group policy under the current revision. Omitted policy preserves it. `coordination.settings` reads the resolved user-level decision policy and cannot modify it.

## Projects screens

TUI Projects is a dedicated full-screen route with the same navigation and layout conventions as Provider Usage. Web and phone expose the matching Projects view. These screens contain project listing, creation, name editing, Session membership and roles, assignment restrictions, delegated-decision narrowing, lifecycle controls, capacity and receipt inspection, and notification preferences. Confirmation prompts may interrupt an action; coordination management is not split into separate dialogs.

Remote operations retain local input validation, optimistic revisions, and backend-owned placement. The authenticated connector resolves groups and Sessions; browser input cannot replace their Locations. Coordination operations are not excluded from Relay MCP. Remote access does not change permission ceilings, deny precedence, hard reviews, or human-only decision settlement.

Consent-gated latency samples accept the closed coordination operation names. They contain timing and outcome fields, not dispatch text, selected-agent rationale, or native decision contents.

## Notification filtering

Default all-source behavior preserves existing focus, root, category, and permission rules. Optional coordinator-only or selected-coordinator filtering is applied at external notification/sound delivery. Selection uses durable coordinator identities, not names. Supported categories are native questions/forms, permission asks, reviews, failures, and completion.

Filtering does not hide in-app history, pending controls, or the human review box. It does not settle requests. Quota and machine-level notifications retain their separate policy. Unknown source state is reported without silently replacing an explicit selection with all sources. Existing delivery identities remain responsible for deduplication.

TUI, web-system notifications, and phone Web Push use the same coordinator selection and category meanings. Phone delivery evaluates the persisted subscription filter against coordinator identities supplied by the authenticated backend. A browser-supplied filter never makes an unverified Session a coordinator.

Both restricted scopes require the source Session itself to be a verified coordinator. Group membership and saved selection IDs do not confer that identity on workers or observers. An unreadable coordinator list withholds restricted delivery without changing the saved filter.

## Verification

Contract tests cover roles, observer isolation, stale fences, cross-group claim races, queue/budget admission, event registration races, cursor gaps, restart/re-arm, cancellation, idempotent dispatch admission, provenance, policy revocation, hard and human-only decision refusal, completion evidence, and cross-directory placement. Screen tests prove actual TUI and web controls; remote and MCP tests cover operation exposure, validation, ownership and external-only category/source filtering. Generated clients and OpenAPI follow Protocol through the owning generation command.
