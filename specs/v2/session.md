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

## One Step Owns One Logical LLM Call

Before each Step, the runner reloads Session History, resolves the selected agent and model, prepares instructions, and materializes tools. Most Steps make one Physical Attempt; overflow-triggered compaction recovery may rebuild the same Step for one additional provider request.

Each complete local tool call is durable before side effects begin. Local calls start eagerly and may run concurrently, but settlement publication remains serialized. Every local and hosted call reaches durable success or failure before the Step publishes its single terminal ended or failed event.

Tool calls belong to their assistant message. `callID` is unique only within that Step, so durable tool events also carry `assistantMessageID`.

Before `runStep` assembles its provider request, orphan reconciliation fails tool calls still projected as streaming or running from an earlier process. It preserves the original assistant attribution and never replays ambiguous side effects.

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

## Compaction Rebuilds Active History

Before each Step, the runner estimates the complete model-visible request against the selected model's context window and reserved output headroom. When compaction is enabled, model limits are known, and enough older Session History is available, the runner may store a structured rolling summary plus bounded recent context instead of sending an over-budget request.

The full transcript remains durable. Active model history after the compaction boundary contains the summary and retained recent context; provider-native continuation state does not cross that boundary.

Implemented: a completed `session.compaction.ended.1` event and its completed compaction projection may carry `messages`, the count folded into that summary operation, and structured `tokens` containing normalized provider-reported input, output, reasoning, cache-read, and cache-write usage. Both fields are optional for compatibility with persisted events and unreported provider usage. A missing token value is absent, not zero.

If the provider reports context overflow before durable assistant output or tool execution, the runner may perform one overflow-triggered compaction and rebuild the same logical Step. A second overflow or any overflow after durable output is terminal.

## Durable Events Are Session-Scoped

`sessions.log({ sessionID, after?, follow? })` verifies the Session and reads public durable Session events after an exclusive aggregate sequence. With `follow: true`, it subscribes before replay and emits one synchronization marker at the captured watermark before live durable events continue.

Live-only text, reasoning, tool-input, and compaction deltas are intentionally absent from replay. The instance-wide live event stream has different schemas and no replay guarantee.

There is no separate finite Session-history endpoint. Request/response consumers use authoritative Session projections such as messages, pending input, and context; replay consumers use the durable log.

## Recovery Boundaries Stay Explicit

An advisory wake does not infer that ambiguous provider work is safe to retry after input promotion. Explicit resume may continue from durable projected history, but automatic hard-crash continuation requires a separate design covering provider-dispatch ambiguity, tool idempotency, retry budgets, and future clustered ownership.

Event replay ownership is separate from Session execution ownership. Local execution remains process-owned until clustering introduces an explicit placement and fencing protocol.
