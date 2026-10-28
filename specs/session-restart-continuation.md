# Decision: Suspend Sessions on Managed-Service Shutdown and Recover Managed Child Tasks

| Field             | Value                    |
| ----------------- | ------------------------ |
| Status            | Accepted and implemented |
| Author            | Kit Langton              |
| Date              | 2026-07-08               |
| Historical source | Upstream issue #35646    |

## Summary

When the managed YCoding server shuts down gracefully, it records each Session it was executing in one private nullable timestamp on the existing Session row: `time_suspended`. Startup never resumes a suspended root Session; the user resumes it manually.

Suspension is an explicit action the managed server invokes during teardown. Managed startup settles interrupted execution history, reconciles durable background-shell notices, and then recovers managed child tasks whose owning process died (see [Managed child-task recovery](#managed-child-task-recovery)). Recovery never replays a provider attempt or a tool call: a child whose interrupted step left no executed tool call with an unknown effect resumes with one new step from its projected history, and a child with such a call waits for a human-only Continue or Stop decision.

The field is not Session status. Live activity remains process-local. Exactly-once provider or tool execution remains out of scope.

## Decision

Add this private Session field and partial index:

```sql
ALTER TABLE session
ADD COLUMN time_suspended INTEGER;

CREATE INDEX session_time_suspended_idx
ON session(time_suspended)
WHERE time_suspended IS NOT NULL;
```

A non-null `time_suspended` means:

> A managed server suspended this Session during graceful shutdown, at this time.

A retained marker never admits or executes work by itself.

The name records the fact rather than one consumer's policy, and it follows the Session table's existing nullable-timestamp idiom. The timestamp also gives operators suspension age for free, which later policy may use without a schema change.

The field does not appear in public `Session.Info` and does not drive UI activity.

## Status and Suspension Are Separate

| Concept           | Values              | Source of truth                       |
| ----------------- | ------------------- | ------------------------------------- |
| Live activity     | `inactive / active` | Process-local `SessionRunCoordinator` |
| Execution history | `started / settled` | Durable lifecycle events              |
| Suspension        | `null / timestamp`  | Private Session-row `time_suspended`  |

A persisted status such as `idle / running / resumable` answers three different questions. `running` becomes stale after a crash, while `resumable` is pending work rather than current status.

## The Managed Server Owns Suspension

Suspension is not layer configuration. `SessionRestart` is an inert core service exposing `suspendActiveSessions`, `reconcileInterruptedExecutions`, `reconcileShells`, `recoverTasks`, and `loseStaleTasks`. Only the managed server (`ycoding serve --service`) invokes `suspendActiveSessions` and `recoverTasks`:

```typescript
// ServerProcess, service mode only
yield * Effect.addFinalizer(() => restart.suspendActiveSessions)
```

Startup never resumes a suspended root Session; the user resumes it manually. Default, embedded, and stdio servers build the same execution layer but never invoke `suspendActiveSessions` or `recoverTasks`, so they never suspend and never recover child tasks; at their startup, `loseStaleTasks` records each active child task whose owner died as `lost`.

`ycoding update` restarts the managed server when `GET /api/session/outstanding` reports no running execution or background shell. `ycoding update --force` also restarts with running work or an unavailable outstanding-work read; an executing Session then records suspension and interruption.

### Graceful shutdown suspends

Teardown ordering makes suspension observe exactly the work a restart interrupts:

1. The HTTP server closes all connections; no new work can arrive.
2. `suspendActiveSessions` snapshots `SessionExecution.active` and sets `time_suspended` for each.
3. Session execution teardown interrupts the still-running drains.

A SIGKILL runs none of this: nothing is suspended. The next managed startup closes the open step and execution as interrupted and recovers managed child tasks by the same rules as after a graceful shutdown.

### Ordinary lifecycle clears stale suspension

The Session execution layer clears the field through durable execution-event `commit` hooks, with no knowledge of server mode:

| Lifecycle event             | `time_suspended`                      |
| --------------------------- | ------------------------------------- |
| Execution started           | `NULL`                                |
| Execution succeeded         | `NULL`                                |
| Execution failed            | `NULL`                                |
| Execution interrupted (any) | unchanged — interruption preserves it |

Interruption must preserve suspension because managed teardown interrupts drains immediately after suspending them. Every other transition clearing the field closes the races: a drain that finishes on its own between suspension and teardown clears its suspension, and an embedded server that completes a suspended Session during the gap clears it on start.

Because the clears are `commit` hooks rather than projections, event replay preserves lifecycle history without recreating or destroying suspension.

## Suspension Is Consumed Atomically

When a drain starts or finishes on its own, its `commit` hook performs a conditional clear:

```sql
UPDATE session
SET time_suspended = NULL
WHERE id = ? AND time_suspended IS NOT NULL
RETURNING id;
```

Only the caller receiving the returned row consumes the suspension. A second caller receives no row.

## Managed Child-Task Recovery

Managed startup runs `recoverTasks` after `reconcileInterruptedExecutions` and `reconcileShells` and before the server reports ready. `reconcileInterruptedExecutions` leaves the open execution of a managed child task untouched while its claiming process is alive or cannot be verified. `recoverTasks` considers each child task in `starting`, `running`, `waiting`, or `cancelling` whose owning process is not alive; tasks of a live owner, including another server, are unchanged, and a failed process-list read changes nothing.

A child was interrupted by a restart when its latest execution lifecycle event is either the startup-recorded `session.execution.failed` with error type `interrupted` (crash), or `session.execution.interrupted` with reason `shutdown` while its `time_suspended` is set (graceful shutdown). An interrupted child's unsettled tool calls are the tool parts of its latest projected assistant message that the runtime dispatched (`time.ran` is set) and that are still `running` or failed as `aborted`. This includes read-only and provider-executed tools. Tool calls whose input never finished streaming were never dispatched and are not unsettled; when the child resumes or asks for a decision, each fails as `tool.input-json` with incomplete, unexecuted arguments, so the next step sends every interrupted call with a result and reruns none.

| Task at startup                                                          | Result                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `waiting` with a complete durable question                               | Unchanged                                                                                                                                                                                                                                            |
| `waiting` without a complete question, or `cancelling`                   | `lost`; the notification waits until the parent next starts                                                                                                                                                                                         |
| `starting` with admitted input                                           | `started`, claimed by this server, and woken                                                                                                                                                                                                         |
| Interrupted, with unsettled tool calls                                   | Still-`running` calls fail with an unknown-effect error and are never retried; the task waits on a recovery question owned by a durable `recovery` review item; the parent is notified and woken                                                     |
| Interrupted or with admitted input, after an automatic recovery whose step never completed | `lost`; no second automatic recovery until a step completes after the previous one                                                                                                               |
| Interrupted, last step ended with non-whitespace text and no local tool continuation, no admitted input | `completed` with that text as the excerpt; no new step                                                                                                     |
| Interrupted, or with admitted input, otherwise                           | `resumed`: claimed by this server, the parent is notified and woken, and one forced drain runs a new step from projected history with no synthetic prompt                                                                                            |
| Anything else, including a user interruption                             | `lost`                                                                                                                                                                                                                                               |

A step that runs from projected history without newly promoted input, including the recovered step, omits from its provider request each trailing assistant message that has no tool part and either failed or holds no non-whitespace text. Projected history keeps these messages. The request therefore ends on the preceding user or tool turn, plus any chronological system update, and no provider receives the interrupted output as an assistant prefill.

Every recovery transition commits in one transaction guarded by the task revision and owner claim, so repeated or concurrent startup passes record it once. Restart-loss events keep the fixed ID `evt_task_restart_lost_<child>_<revision>`, and automatic recoveries use `evt_task_restart_resumed_<child>_<revision>`.

A drain runs a managed child only while this process holds its claim. A claim left by another process, live or dead, skips the drain until recovery or a parent or human transition claims the task.

### Human-only recovery decision

The `recovery` review item lists the interrupted calls by message ID, call ID, and tool name; it carries no tool input. Recovery records the failed calls, the question, and the item in one transaction while it holds the family review lock. Like sleep-entry conversions, recovery holds may exceed `max_pending_reviews`; every new deferral is still rejected while the family is at or above the cap. Only `session.review.decide` with `{ kind: "recovery", choice: "continue" | "stop" }` settles it. Autonomy modes, goals, sleep, the decision model, question timeouts, and the parent's `subagent_control answer` cannot answer the question it owns, and the open item pauses goal continuation and blocks completion receipts like any open review item.

- Continue admits a steer from the user stating that the interrupted calls' effects are unknown, answers the question, claims the task, records the decision, and wakes the child. The interrupted calls are excluded from later recovery questions.
- Stop records the task as `lost`, notifies and wakes the parent, and records the decision. A stopped child exposes `stoppedRecovery.itemID` on task reads. While stopped, `subagent_control send`, plugin recovery, admitted inputs, and later startups cannot run it. The same item accepts exactly one later human `continue`, which admits the user's steer, restarts the task, and wakes it; every other repeated decision is a conflict.

## Failure Semantics

| Event                                               | Result                                                                                                  |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Graceful managed shutdown during execution          | Session is suspended and interrupted; root Sessions are not resumed; child tasks follow recovery rules   |
| Managed server is killed before graceful closeout   | Startup settles the failed run and lost shell notices; child tasks follow recovery rules                 |
| Managed server dies between suspension and teardown | Startup settles the failed run; child tasks follow recovery rules                                        |
| Interrupted tool has uncertain side effects         | The call is never replayed; continuing its child requires a human Continue                              |
| Restart again before a recovered step completes     | The child is lost rather than recovered automatically again                                            |

## Migration Does Not Infer Historical Intent

The migration adds the nullable column with no backfill. It does not scan historical shutdown events.

An old shutdown event records what happened; it does not prove that a future process is authorized to start new work.

## Ranked Alternatives

| Rank | Option                                  | Verdict   | Reason                                                                          |
| ---: | --------------------------------------- | --------- | ------------------------------------------------------------------------------- |
|    1 | Daemon-invoked restart actions          | Preferred | The restart authority acts explicitly; execution layer stays generic            |
|    2 | Execution-layer configuration flag      | Rejected  | Threads a mode bit through server, routes, and layer construction               |
|    3 | Dedicated continuation table            | Reserve   | Useful if continuation later needs metadata, leases, retries, or multiple rows  |
|    4 | Leased continuation queue               | Defer     | Solves claimant failure but adds acknowledgement, expiry, and fencing semantics |
|    5 | Persisted general Session status        | Reject    | Conflates activity, history, and pending work                                   |
|    6 | Scan lifecycle history on every startup | Reject    | Repeats unbounded historical work and lacks direct atomic consumption           |

## Coverage

Regression coverage verifies:

- A suspension can be consumed only once per Session.
- Generic lifecycle publication and replay do not infer suspension.
- Concurrent managed-service processes elect one server, and startup resumes no suspended root Session.
- Teardown interruption preserves suspension; a drain finishing on its own clears it.
- Crash and graceful restarts classify child tasks identically; unsettled executed calls, including reads and provider-executed calls, require a human decision; a final answer settles without a step.
- Stop persists across restarts and blocks parent, plugin, and startup resumption until a human Continue.
- A second restart before a recovered step completes records the child as lost; foreign live owners are unchanged; concurrent startup passes record one recovery.
- Managed startup recovers child tasks and non-managed startup records them as lost.

## Non-Goals

- Resuming suspended root Sessions automatically at server startup.
- Replaying an interrupted provider attempt or tool call.
- Persisting authoritative live Session status.
- Coordinating Session execution across independent processes or a cluster.
- Guaranteeing exactly-once provider requests or tool side effects.
- Retrying a continuation after its suspension has been consumed.

## Historical source records

- Upstream issue #35646: auto-resume active Sessions after server restart.
- Upstream draft PR #35778: resume Sessions after restart.
- Upstream draft PR #35820: resume Sessions after restart.
- Upstream issue #35642: interrupted work remains spinning after machine restart.
