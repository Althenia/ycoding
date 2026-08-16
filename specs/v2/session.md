# V2 Session Contract

Status: **Current semantic overview.** Protocol owns public operations, Schema owns public shapes and durable events, and Core owns execution and persistence behavior. [CONTEXT.md](../../CONTEXT.md) defines the canonical terms used here.

## Prompt Admission Precedes Execution

`SessionV2.prompt(...)` records one durable `session.input.admitted` fact and one `session_pending` row before advisory execution begins. Pending input remains outside model-visible Session History until promotion. The promotion transaction publishes `session.input.promoted`, projects the visible message, and consumes the pending row atomically.

Reusing a Session ID adopts the existing Session. Reusing a prompt message ID reconciles an exact retry only when Session, prompt, and delivery mode match; conflicting reuse fails. A retry of an already-promoted input reconciles against projected history and its durable admission event.

`resume` controls scheduling, not durability:

- Omitted or `true` records the input, then schedules `SessionExecution.wake(sessionID)`.
- `false` records the input without scheduling execution.

Delivery is explicit:

- `steer` is the default. Steers promote together at the next Safe Step Boundary while the current Session Drain still requires continuation.
- `queue` remains pending while the Session can continue. When the Session would otherwise become idle, one queued input promotes; the runner then reevaluates continuation before promoting another.

Promoting new user input resets the selected agent's step allowance. A batch of steers resets it once.

Manual compaction uses the same pending store as one coalesced barrier. The barrier blocks later input promotion until compaction ends or fails, then is consumed.

## Execution Is Process-Local

`SessionExecution` is process-global and keyed only by Session ID. At drain start it loads the Session, enters its Location through `LocationServiceMap`, and invokes the Location-scoped runner. The runner, model resolution, tools, permissions, plugins, and filesystem remain Location-scoped.

`SessionRunCoordinator` provides the local ownership rules:

- Explicit resumes join the active execution for the same Session.
- Repeated wakes coalesce into one follow-up drain.
- Different Sessions run concurrently.
- Interruption stops locally owned execution without deleting pending input.

The public interrupt operation verifies that the durable Session exists. An unknown Session fails with `SessionNotFoundError`; a known Session that is idle, settled, or not locally owned is a no-op.

`sessions.active()` snapshots foreground drains currently owned by this process. Durable execution events are historical observations, not liveness or ownership records.

The managed server provides graceful restart continuity through private Session suspension. Shutdown marks active Sessions before interrupting them; the next managed server atomically consumes each suspension and schedules at most one resume. Hard-crash recovery and exactly-once provider or tool execution remain out of scope. See [Managed restart continuation](./session-restart-continuation.md).

## Model Selection Requires Context Fit

`POST /api/session/:sessionID/model` resolves the requested provider and model in the Session Location's catalog, then estimates the active rolling summary and recent model-visible messages against the target context window after reserving its maximum output and configured `compaction.context_safety_margin_tokens`. The margin is passed explicitly and defaults to zero when absent.

If the context fits, the operation preserves its `204 No Content` response and appends the existing `session.model.selected` event. The next provider request receives a distinct model-specific cache namespace and invalidation reason through the existing request path.

If it does not fit, the endpoint returns `409 ModelSwitchBlockedError` and changes no durable Session state. Its structured payload contains the current and target models, estimated current context tokens, target safe input tokens, required reduction tokens, and `context-window-exceeded`. `maximumSafeSummaryBoundary` is present only when `compaction.keep_recent_messages` is configured and retaining that tail is estimated to fit; it is advisory. The switch never starts compaction, deletes or rewrites transcript rows, or changes the selected model.

When a Session drain is active, selection waits for that drain to settle before checking the persisted context and changing the model. The active provider request therefore completes using its original model; the selected model applies only at the following request boundary.

## One Step Owns One Logical LLM Call

Before each Step, the runner reloads Session History, resolves the selected agent and model, prepares instructions, and materializes tools. Most Steps make one Physical Attempt; overflow-triggered compaction recovery may rebuild the same Step for one additional provider request.

Each complete local tool call is durable before side effects begin. Local calls start eagerly and may run concurrently, but settlement publication remains serialized. Every local and hosted call reaches durable success or failure before the Step publishes its single terminal ended or failed event.

Every Step that publishes `session.step.started.1` publishes exactly one terminal `session.step.ended.1` or `session.step.failed.1`. Provider step settlement is required for `Step.Ended`. A malformed started Step with missing settlement fails truthfully as `provider.invalid-output`; an unstarted empty malformed request may proceed to the bounded terminal-silence recovery without inventing a Step event. A valid settled response with no non-whitespace assistant text and no local-tool continuation may start exactly one text-only recovery Step. The recovery disables tools and stored Responses continuation, carries no synthetic max-step message, and must fail without a third Step unless it receives both real provider settlement and non-whitespace assistant text.

Tool calls belong to their assistant message. `callID` is unique only within that Step, so durable tool events also carry `assistantMessageID`.

Before `runStep` assembles its provider request, orphan reconciliation fails tool calls still projected as streaming or running from an earlier process. It preserves the original assistant attribution and never replays ambiguous side effects.

Before each physical attempt, the runner derives the promoted user-message IDs present in the final model-visible message slice after instruction loading, active-history selection, compaction, stored-response continuation slicing, and `session:context` hook shaping. The single eager `llm.stream(request)` invocation does not itself create a receipt. When the provider stream emits its first event, the runner first appends `session.input.consumed.1` for IDs without an earlier consumption fact, then projects that provider event; a transport failure before the first stream event creates no consumption fact. One event may contain multiple coalesced steers. The user-message projection stores the event time as optional `time.consumed`, so first consumption remains idempotent across retry, restart, and resident-transcript eviction.

The event contains only Session and message IDs. It exposes no provider request ID, prompt content, cache digest, credential, or private request-ledger field. A pre-hook provider-ledger `inputID`, a visible transcript row, an assistant step, and a provider response are not substitutes for exact final request membership. Historical user messages omit `time.consumed` and remain compatible without a data migration; YCoding does not infer receipts retroactively.

After local settlement, continuation reloads projected history and begins a new Step. The runner never delegates orchestration to an in-memory tool loop.

## Retry Is Narrow And Observable

Core retries typed rate-limit, provider-internal, and transport failures only before durable assistant content, tool-call, tool-output, or tool-execution evidence exists. The initial request plus at most four retries use exponential backoff, increased when the provider supplies a longer retry delay.

Each retry attempt is a distinct Step, consumes the selected agent's allowance, and reuses the assistant message ID while no durable output exists. `session.retry.scheduled` records the next attempt and absolute retry time. A later Step start or terminal failure clears projected retry state. Surviving retry history never triggers post-crash recovery by itself.

A normalized content-filter finish fails the Step. Any partial streamed content remains visible.

## Instructions Are Value Deltas

Instruction sync persists values, never rendered privileged prose. The only durable fact is `session.instructions.updated { delta }`, mapping each changed source key to a SHA-256 content hash, with the literal `"removed"` for observed absence. Canonical JSON bodies live once in the machine-local `instruction_blob` store; `instruction_state` is a rebuildable fold cache, never primary state. The runner explicitly combines built-ins, ambient discovery, selected-agent skill guidance, references, MCP guidance, and API-managed instruction entries. There is no instruction registry.

At each Safe Step Boundary the runner reads every source concurrently exactly once, hashes encoded values, and admits one delta atomically with its new blobs before input promotion. The initial delta must be complete; an unavailable source blocks only that initial delta and otherwise silently retains the stored value. Initial instructions and chronological update messages are rendered from stored values during request assembly and are never persisted; clients display changed keys.

An instruction epoch spans completed compactions. `session.compaction.ended` moves the epoch start to its exact sequence, making current values initial, without reading sources or authoring an instruction event. Session movement and committed revert clear the fold. Forks record an authoritative parent sequence and derive values from the parent's ancestry through that cutoff. Model selection affects request assembly but is not itself an instruction source. See the [instruction sync design](./instruction-sync-proposal.md).

## Session Skill Conflict Resolution

Implemented: `SessionV2.resolveSkillConflict({ sessionID, winner, loser })` accepts two currently active skills only when the derived status reports a skill conflict between them. It appends `session.skill.deactivated.1` with the losing skill ID, its activation message ID, and reason `conflict_resolved`. The projector adds that deactivation fact to the existing activation message; it does not create a second skill-status store.

`SessionSkillStatus` folds activation messages, tool activations, agent switches, completed compactions, and projected conflict resolutions in order. A resolved loser is inactive with `conflict_resolved`, has no reported conflicts, and can become active again only through a later ordinary activation. The winner remains active with its original instruction content. A conflict-free Session rejects resolution without a durable event or projection change, and resolution never resumes Session execution.

Implemented HTTP contract: `POST /api/session/:sessionID/skill/resolve` uses the standard Session location middleware, accepts `{ winner: Skill.ID, loser: Skill.ID }`, and returns `204 No Content`. An unknown Session returns `SessionNotFoundError`. A missing, inactive, or conflict-free pair returns `SkillConflictNotFoundError` with the fixed message `Skill conflict not found`; the response omits the Core error tag and both skill identifiers.

Compatibility: durable projectors dispatch by exact `<type>.<version>`, and aggregate reads skip event types absent from an older manifest while advancing across their sequence. Conflict resolution therefore uses the new `session.skill.deactivated.1` type instead of changing or bumping `session.skill.activated.1`; bumping activation would leave existing `.1` records without the current activation projector. The projected `skillDeactivations` field is optional on existing skill and assistant messages, so new readers decode historical messages that omit it. The new closed-enum value is isolated to the new event and optional projection fact; it is not written into an existing versioned event payload.

## Explicit Summary Rebuilds Active History

The main agent may call `conversation_summarize` through one existing message boundary. The hidden summarizer must return a validated, versioned TOON checkpoint containing enough objective, decision, constraint, progress, blocker, and identifier detail to continue without the covered rows. Summarization is explicit and advisory; context pressure never starts it automatically.

A successful write atomically replaces the previous summary and covered message-producing history with the new summary while preserving the configured recent tail and protected lifecycle history. The current projected transcript, resident TUI transcript, and next model request contain the latest summary plus retained recent messages; covered transcript rows are not retained as a second visible or model-facing history. Provider-native continuation state does not cross that boundary.

Implemented: a completed `session.compaction.ended.1` event and its completed compaction projection may carry `messages`, the count folded into that summary operation, and structured `tokens` containing normalized provider-reported input, output, reasoning, cache-read, and cache-write usage. Both fields are optional for compatibility with persisted events and unreported provider usage. A missing token value is absent, not zero.

Compaction helper requests use an internal cache namespace scope and never share a provider cache key with ordinary Session steps. Existing ordinary-step namespace bytes remain stable. Parent and child Sessions may reuse a provider prefix only when every model-visible namespace input is equal, including provider, model, variant, policy revision, permissions, system, and tool definitions.

Provider context overflow is terminal. The runtime does not start summarization or rebuild a Step automatically; the agent must call `conversation_summarize` before exhaustion.

## Cache reset diagnostics

The bounded Session diagnostics response includes the latest provider-request invalidation reason without exposing prompt content, full cache keys, system digests, or tool digests. Compatibility reads treat a missing historical model variant as `default`. For a newly admitted request, a prior compaction produces `compaction-reset`; otherwise a changed provider or model produces `model-switched`, and a changed normalized variant produces `model-variant-switched`. These reasons take precedence over system, tool, and generic prefix-change reasons.

## Durable Events Are Session-Scoped

`sessions.log({ sessionID, after?, follow? })` verifies the Session and reads public durable Session events after an exclusive aggregate sequence. With `follow: true`, it subscribes before replay and emits one synchronization marker at the captured watermark before live durable events continue.

Live-only text, reasoning, tool-input, and compaction deltas are intentionally absent from replay. The instance-wide live event stream has different schemas and no replay guarantee.

There is no separate finite Session-history endpoint. Request/response consumers use authoritative Session projections such as messages, pending input, and context; replay consumers use the durable log.

## Bounded Managed Subagent Pages

`GET /api/session/:parentID/subagent` returns one page of direct durable managed-child task records. `limit` is a positive integer, defaults to `10`, and cannot exceed `10`. The response is `{ data, summary, cursor }`: `data` contains at most the requested page size; `summary` contains exact `total`, `active`, `running`, and `waiting` counts; and `cursor.previous` or `cursor.next` is an opaque base64url value when an adjacent page exists.

Task order is deterministic: `waiting`, `starting`, `running`, `cancelling`, then the terminal group (`cancelled`, `completed`, `failed`, `lost`); records in each group sort by durable `time.updated` descending and Session ID ascending. Cursors carry the parent Session ID, this rank, durable update time, Session ID, and direction. The server rejects malformed cursors and cursors for another parent with `InvalidCursorError`.

The page read verifies the parent Session and calculates aggregates and rows in one database transaction. Paging neither removes child Sessions nor deletes task, message, event, permission-ceiling, ownership, nesting, or background-execution state. The full internal task list remains available for the independently bounded model-facing TeamView.

For each parent, the TUI retains only the current page's at-most-10 task metadata rows and replaces them on previous or next navigation. Exact summary totals remain independent from resident rows. Sibling navigation first locates an absent current child by loading pages lazily, then loads an adjacent page only when navigation crosses the current page boundary; this changes only volatile TUI residency and never durable child state.

## Recovery Boundaries Stay Explicit

An advisory wake does not infer that ambiguous provider work is safe to retry after input promotion. Explicit resume may continue from durable projected history, but automatic hard-crash continuation requires a separate design covering provider-dispatch ambiguity, tool idempotency, retry budgets, and future clustered ownership.

Event replay ownership is separate from Session execution ownership. Local execution remains process-owned until clustering introduces an explicit placement and fencing protocol.
