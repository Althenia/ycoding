# Decision: Suspend Sessions on Managed-Service Shutdown

| Field             | Value                    |
| ----------------- | ------------------------ |
| Status            | Accepted and implemented |
| Author            | Kit Langton              |
| Date              | 2026-07-08               |
| Historical source | Upstream issue #35646    |

## Summary

When the managed YCoding server shuts down gracefully, it records each Session it was executing in one private nullable timestamp on the existing Session row: `time_suspended`. Startup never resumes a suspended Session; the user resumes it manually.

Suspension is an explicit action the managed server invokes during teardown. Automatic continuation would retry provider and tool work whose outcome is ambiguous, so no server schedules it; that requires an explicit durable crash-recovery design with admission rules.

The field is not Session status. Live activity remains process-local. Hard-crash recovery and exactly-once provider or tool execution remain out of scope.

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

Suspension is not layer configuration. `SessionRestart` is an inert core service exposing the actions `suspendActiveSessions` and `reconcileInterruptedExecutions`. Only the managed server (`ycoding serve --service`) invokes `suspendActiveSessions`:

```typescript
// ServerProcess, service mode only
yield * Effect.addFinalizer(() => restart.suspendActiveSessions)
```

Startup never resumes a suspended Session; the user resumes it manually. Default, embedded, and stdio servers build the same execution layer but never invoke `suspendActiveSessions`, so they never suspend.

`ycoding update` restarts the managed server only after `GET /api/session/outstanding` reports no outstanding Session work, so an update restart suspends nothing.

### Graceful shutdown suspends

Teardown ordering makes suspension observe exactly the work a restart interrupts:

1. The HTTP server closes all connections; no new work can arrive.
2. `suspendActiveSessions` snapshots `SessionExecution.active` and sets `time_suspended` for each.
3. Session execution teardown interrupts the still-running drains.

A SIGKILL runs none of this: nothing is suspended, and the user resumes manually. That is deliberate — automatic post-crash continuation would retry ambiguous provider and tool work.

### Ordinary lifecycle clears stale suspension

The Session execution layer clears the field through EventV2 live `commit` hooks, with no knowledge of server mode:

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

## Failure Semantics

The design schedules no automatic continuation; the user decides whether to resume interrupted work.

| Event                                               | Result                                                                        |
| --------------------------------------------------- | ----------------------------------------------------------------------------- |
| Graceful managed shutdown during execution          | Session is suspended and interrupted; the next server does not resume it      |
| Managed server is killed before graceful closeout   | Nothing is suspended; user resumes manually                                   |
| Managed server dies between suspension and teardown | Session stays suspended; the next server does not resume it                   |
| Interrupted tool has uncertain side effects         | Orphan reconciliation records interruption rather than replaying the old call |

Leaving continuation to the user is safer than restarting ambiguous provider or tool work.

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
- Concurrent managed-service processes elect one server, and startup resumes no suspended Session.
- Teardown interruption preserves suspension; a drain finishing on its own clears it.

## Non-Goals

- Resuming suspended Sessions automatically at server startup.
- Recovering unmatched execution after a hard process or machine crash.
- Persisting authoritative live Session status.
- Coordinating Session execution across independent processes or a cluster.
- Guaranteeing exactly-once provider requests or tool side effects.
- Retrying a continuation after its suspension has been consumed.

## Historical source records

- Upstream issue #35646: auto-resume active Sessions after server restart.
- Upstream draft PR #35778: resume Sessions after restart.
- Upstream draft PR #35820: resume Sessions after restart.
- Upstream issue #35642: interrupted work remains spinning after machine restart.
