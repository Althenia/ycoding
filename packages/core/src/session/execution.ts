export * as SessionExecution from "./execution"

import { Cause, Context, Effect, Exit, Layer, Option } from "effect"
import { LLMError } from "@ycoding-ai/ai"
import { EventRuntime } from "../event"
import { LocationServiceMap } from "../location-service-map"
import { makeGlobalNode } from "../effect/app-node"
import { SessionEvent } from "./event"
import { SessionRunCoordinator } from "./run-coordinator"
import { SessionRunner } from "./runner/index"
import { SessionSchema } from "./schema"
import { SessionStore } from "./store"
import { toSessionError } from "./to-session-error"
import { ScopeUnavailableError, StepFailedError, UserInterruptedError } from "./error"
import { Database } from "../database/database"
import { Hash } from "../util/hash"
import { SessionAutonomy } from "./autonomy"
import { SessionCompactionExecution } from "./compaction-execution"
import { SessionMessage } from "./message"
import { SessionPending } from "./pending"
import { SessionHistory } from "./history"
import { SessionPendingTable, SessionTaskTable } from "./sql"
import { and, eq, inArray, ne, sql } from "drizzle-orm"
import { SessionOrchestration } from "@ycoding-ai/schema/session-orchestration"
import { Shell } from "../shell"
import { SessionGoal } from "./goal"
import { SessionReviewFold } from "./review-fold"
import { SessionCompletion } from "./completion"
import { Job } from "../job"
import type { ShellLedger } from "../shell/ledger"
import { SessionStatusEvent } from "@ycoding-ai/schema/session-status-event"
import type { SessionError } from "@ycoding-ai/schema/session-error"
import { EventTable } from "../event/sql"

const admittedType = EventRuntime.versionedType(SessionEvent.InputAdmitted.type, SessionEvent.InputAdmitted.durable.version)

function assistantText(assistant: SessionMessage.Assistant | undefined) {
  return assistant?.content
    .filter((part): part is Extract<(typeof assistant.content)[number], { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("")
}

function failureUnit(error: SessionError.Error, assistant: SessionMessage.Assistant | undefined, session: SessionSchema.Info) {
  if (error.type.startsWith("tool.")) {
    const failed = assistant?.content.findLast((part) => part.type === "tool" && part.state.status === "error")
    return failed?.type === "tool" ? `tool/${failed.name}` : "tool"
  }
  const model = assistant?.model ?? session.model
  return model ? `model/${model.providerID}/${model.id}` : "session"
}

export interface Interface {
  readonly prepareTask: (owner: ShellLedger.Process) => Effect.Effect<void, ScopeUnavailableError>
  /** Snapshots active execution owned by this process. */
  readonly active: Effect.Effect<ReadonlySet<SessionSchema.ID>>
  /** Starts execution while idle or joins the active execution. */
  readonly resume: (sessionID: SessionSchema.ID, owner?: ShellLedger.Process) => Effect.Effect<void, SessionRunner.RunError | ScopeUnavailableError>
  /** Registers newly recorded work. Repeated wakeups may coalesce. */
  readonly wake: (sessionID: SessionSchema.ID, owner?: ShellLedger.Process) => Effect.Effect<void, ScopeUnavailableError>
  /** Interrupt active work owned by this process. Idle interruption is a no-op. */
  readonly interrupt: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  /** Resolves once this process owns no active execution for the Session. Returns immediately when idle and never starts work. */
  readonly awaitIdle: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  readonly shutdown: Effect.Effect<void>
  /**
   * Runs one exclusive process-local transition for the Session. Transitions for the same
   * Session serialize; doorbells raised while a transition is reserved are coalesced and
   * forwarded once after the last release, and explicit resumes wait for reserved transitions.
   * `awaitIdle` keeps observing only drain settlement.
   */
  readonly withTransition: <A, E, R>(
    sessionID: SessionSchema.ID,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>
}

/** Routes execution from a Session ID to the runner owned by that Session's Location. */
export class Service extends Context.Service<Service, Interface>()("@ycoding/SessionExecution") {}

type InterruptReason = "user" | "shutdown" | "superseded"

export function terminal(exit: Exit.Exit<void, SessionRunner.RunError | ScopeUnavailableError>, reason?: InterruptReason) {
  if (Exit.isSuccess(exit)) return { type: "succeeded" as const }
  if (Cause.hasInterrupts(exit.cause)) return { type: "interrupted" as const, reason: reason ?? "shutdown" }
  const failure = Cause.squash(exit.cause)
  if (failure instanceof UserInterruptedError) return { type: "interrupted" as const, reason: "user" as const }
  return { type: "failed" as const, error: toSessionError(failure) }
}

const validateTaskOwner = (candidate: ShellLedger.Process) => Effect.gen(function* () {
  yield* EventRuntime.requireTaskOwner.pipe(Effect.provideService(EventRuntime.TaskOwner, candidate))
  if (candidate.pid !== process.pid)
    return yield* new EventRuntime.TaskOwnerUnavailableError({ message: "Managed task owner is not the current process" })
})

/** Process-local execution: drains run in this process, routed through the Session's Location graph. */
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const store = yield* SessionStore.Service
    const locations = yield* LocationServiceMap.Service
    const events = yield* EventRuntime.Service
    const db = (yield* Database.Service).db
    const autonomy = yield* SessionAutonomy.Service
    const compactionExecution = yield* SessionCompactionExecution.Service
    const jobs = yield* Job.Service
    let owner: ShellLedger.Process | undefined
    const bindTaskOwner = (candidate: ShellLedger.Process) => Effect.gen(function* () {
      yield* validateTaskOwner(candidate)
      if (owner && (owner.pid !== candidate.pid || owner.started !== candidate.started || owner.pgid !== candidate.pgid))
        return yield* new EventRuntime.TaskOwnerUnavailableError({ message: "Managed task owner changed during execution" })
      owner = candidate
    })
    const completion = SessionCompletion.make({ db, events, jobs })
    const reportLifecycle = <A>(sessionID: SessionSchema.ID, effect: Effect.Effect<A>) =>
      effect.pipe(
        Effect.tapCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.logError("Failed to publish Session execution lifecycle", cause).pipe(
                Effect.annotateLogs({ sessionID }),
              ),
        ),
        Effect.asVoid,
      )
    const goalWait = Effect.fnUntraced(function* (sessionID: SessionSchema.ID, session: SessionSchema.Info) {
      const activeChild = yield* db
        .select({ sessionID: SessionTaskTable.session_id })
        .from(SessionTaskTable)
        .where(
          and(
            eq(SessionTaskTable.parent_id, sessionID),
            inArray(SessionTaskTable.state, ["starting", "running", "waiting", "supervising", "cancelling"]),
          ),
        )
        .limit(1)
        .get()
        .pipe(Effect.orDie)
      if (activeChild) return "child" as const
      if ((yield* SessionReviewFold.openCount(db, sessionID)) > 0) return "review" as const
      const activeShell = yield* Effect.gen(function* () {
        const shell = yield* Shell.Service
        return (yield* shell.list()).some((info) => info.metadata.sessionID === sessionID)
      }).pipe(Effect.provide(locations.get(session.location, [LocationServiceMap.full])))
      if (activeShell) return "shell" as const
      return undefined
    })

    const goalSession = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
      const snapshot = yield* autonomy
        .snapshot(sessionID)
        .pipe(Effect.catchTag("SessionAutonomy.NotFound", () => Effect.succeed(undefined)))
      if (!snapshot?.state.goal || snapshot.state.goal.status !== "active") return undefined
      const session = yield* store.get(sessionID)
      if (!session || session.scope === "standalone") return undefined
      return { snapshot, goal: snapshot.state.goal, session }
    })

    const continuedGoal = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
      const current = yield* goalSession(sessionID)
      if (!current) return undefined
      const assistant = yield* SessionHistory.latest(db, sessionID, "assistant")
      if (assistant?.error !== undefined) return yield* failedGoal(sessionID, assistant.error)
      const wait = yield* goalWait(sessionID, current.session)
      if (wait) {
        yield* autonomy.recordWait({ sessionID, expectedSequence: current.snapshot.sequence, wait })
        return undefined
      }
      const goals = yield* SessionGoal.Service.pipe(Effect.provide(locations.get(current.session.location, [LocationServiceMap.full])))
      const continuation = yield* goals.continuation({
        session: current.session,
        goal: current.goal,
        latestAssistantText: assistantText(assistant),
      })
      const advanced = yield* autonomy.advanceIfCurrent({ sessionID, expectedSequence: current.snapshot.sequence })
      if (!advanced.applied || !advanced.state.goal || advanced.state.goal.status !== "active") return undefined
      return {
        id: SessionMessage.ID.make(`msg_goal_${Hash.sha256(`${sessionID}\0${advanced.state.goal.iteration}`).slice(0, 24)}`),
        text: continuation.steer,
        description: "Goal · steer",
        metadata: { autonomy: { goal: true, iteration: advanced.state.goal.iteration } },
      }
    })

    const failedGoal = Effect.fnUntraced(function* (sessionID: SessionSchema.ID, error: SessionError.Error) {
      const current = yield* goalSession(sessionID)
      if (!current) return undefined
      const assistant = yield* SessionHistory.latest(db, sessionID, "assistant")
      const unit = failureUnit(error, assistant, current.session)
      const fingerprint = `${error.type}:${unit}`
      const condition = yield* goalCondition(sessionID, current.session, current.snapshot.state)
      const recorded = yield* autonomy.recordFailure({
        sessionID,
        expectedSequence: current.snapshot.sequence,
        fingerprint,
        class: error.type,
        unit,
        condition,
      })
      const goal = recorded.state.goal
      if (!recorded.applied || !goal?.failure) return undefined
      if (!goal.failure.recovering) {
        yield* Effect.logWarning("Autonomous goal stalled on a repeated failure; waiting for a changed condition").pipe(
          Effect.annotateLogs({ sessionID, fingerprint, count: goal.failure.count, errorClass: error.type }),
        )
        return undefined
      }
      const fallback = `Recover from the failed step (${error.type} on ${unit}): inspect the current state, then resume the unfinished work toward the goal with an approach that avoids the same failure.`
      const goals = yield* SessionGoal.Service.pipe(Effect.provide(locations.get(current.session.location, [LocationServiceMap.full])))
      const text = yield* goals
        .steer({ session: current.session, goal, phase: "recover", latestAssistantText: assistantText(assistant) })
        .pipe(
          Effect.catchTag("SessionGoal.Error", (cause) =>
            Effect.logWarning("Goal recovery steer generation failed; admitting the deterministic recovery steer", cause).pipe(
              Effect.annotateLogs({ sessionID, fingerprint }),
              Effect.as(fallback),
            ),
          ),
        )
      return {
        id: SessionMessage.ID.make(`msg_goal_${Hash.sha256(`${sessionID}\0recover\0${fingerprint}\0${condition}`).slice(0, 24)}`),
        text,
        description: "Goal · recovery",
        metadata: { autonomy: { goal: true, recovery: fingerprint } },
      }
    })

    const goalCondition = Effect.fnUntraced(function* (
      sessionID: SessionSchema.ID,
      session: SessionSchema.Info,
      state: SessionAutonomy.State,
    ) {
      const input = yield* db
        .select({ seq: sql<number | null>`max(${EventTable.seq})` })
        .from(EventTable)
        .where(
          and(
            eq(EventTable.aggregate_id, sessionID),
            eq(EventTable.type, admittedType),
            sql`substr(coalesce(json_extract(${EventTable.data}, '$.inputID'), ''), 1, 9) <> 'msg_goal_'`,
          ),
        )
        .get()
        .pipe(Effect.orDie)
      return Hash.json({
        input: input?.seq ?? 0,
        agent: session.agent ?? null,
        model: session.model ?? null,
        decisions: SessionAutonomy.decisions(state),
        defer: SessionAutonomy.isDeferred(state),
      })
    })

    const admitGoalContinuation = Effect.fnUntraced(function* (
      sessionID: SessionSchema.ID,
      steer: { readonly id: SessionMessage.ID; readonly text: string; readonly description: string; readonly metadata: Record<string, unknown> },
    ) {
      const input = SessionPending.Message.make({
        type: "synthetic",
        data: { text: steer.text, description: steer.description, metadata: steer.metadata },
        delivery: "steer",
      })
      return yield* SessionPending.admit(db, events, { id: steer.id, sessionID, input }).pipe(
        Effect.as(true),
        Effect.catchDefect((defect) =>
          defect instanceof SessionPending.LifecycleConflict ? Effect.succeed(false) : Effect.die(defect),
        ),
      )
    })

    // Starting or finishing on its own clears stale suspension; interruption preserves it because
    // managed-server teardown suspends active Sessions immediately before interrupting their drains.
    const clearSuspensionOnCommit = (sessionID: SessionSchema.ID) => ({
      commit: () => Effect.asVoid(store.consumeSuspended(sessionID)),
    })
    // Sessions woken since their last drain began. A wake rung after the final drain's promotion
    // starts a successor drain, which a completed task would gate out, so completion defers to it.
    const woken = new Set<SessionSchema.ID>()
    const failedSuccessorLimit = 3
    const failedPending = new Map<SessionSchema.ID, { count: number; ids: ReadonlySet<SessionMessage.ID> }>()
    const stopRequested = new Set<SessionSchema.ID>()
    const drainPendingSnapshot = new Map<SessionSchema.ID, ReadonlySet<SessionMessage.ID>>()
    const pendingInputIDs = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
      const rows = yield* db
        .select({ id: SessionPendingTable.id })
        .from(SessionPendingTable)
        .where(and(eq(SessionPendingTable.session_id, sessionID), ne(SessionPendingTable.type, "compaction")))
        .all()
        .pipe(Effect.orDie)
      return new Set(rows.map((row) => SessionMessage.ID.make(row.id)))
    })
    const retryFailedPending = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
      const snapshot = drainPendingSnapshot.get(sessionID)
      drainPendingSnapshot.delete(sessionID)
      if (stopRequested.has(sessionID)) return
      if (snapshot === undefined || snapshot.size === 0) return
      const task = yield* db
        .select({ state: SessionTaskTable.state })
        .from(SessionTaskTable)
        .where(eq(SessionTaskTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      if (task) return
      const ids = yield* pendingInputIDs(sessionID)
      if (ids.size === 0) {
        failedPending.delete(sessionID)
        return
      }
      if ([...snapshot].some((id) => !ids.has(id))) return
      const previous = failedPending.get(sessionID)
      const unchanged =
        previous !== undefined && previous.ids.size === ids.size && [...ids].every((id) => previous.ids.has(id))
      const count = unchanged ? previous.count + 1 : 1
      failedPending.set(sessionID, { count, ids })
      if (count <= failedSuccessorLimit) yield* wake(sessionID)
    })
    const settleTask = Effect.fnUntraced(function* (sessionID: SessionSchema.ID, outcome: ReturnType<typeof terminal>) {
      const task = yield* db
        .select({ state: SessionTaskTable.state })
        .from(SessionTaskTable)
        .where(eq(SessionTaskTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      if (task?.state !== "running" || outcome.type === "interrupted") return
      if (outcome.type === "failed") {
        yield* events.publish(SessionEvent.Task.Updated, {
          sessionID,
          change: {
            type: "failed",
            error: SessionOrchestration.truncateUtf8(outcome.error.message, 16 * 1024),
            excerpt: SessionOrchestration.truncateUtf8(outcome.error.message, 16 * 1024),
          },
        })
        return
      }
      const latestAssistant = yield* SessionHistory.latest(db, sessionID, "assistant")
      const assistant = latestAssistant?.error === undefined ? latestAssistant : undefined
      const text =
        latestAssistant?.error !== undefined
          ? latestAssistant.error.message
          : assistant?.content
              .filter((part): part is Extract<(typeof assistant.content)[number], { type: "text" }> => part.type === "text")
              .map((part) => part.text)
              .join("")
      const excerpt = text === undefined ? undefined : SessionOrchestration.truncateUtf8(text, 16 * 1024)
      yield* events.publishBatch(
        [{ definition: SessionEvent.Task.Updated, data: { sessionID, change: { type: "completed", excerpt } } }],
        {
          when: Effect.gen(function* () {
            const current = yield* db
              .select({ state: SessionTaskTable.state })
              .from(SessionTaskTable)
              .where(eq(SessionTaskTable.session_id, sessionID))
              .get()
              .pipe(Effect.orDie)
            return current?.state === "running" && !woken.has(sessionID)
          }),
        },
      )
    })
    let wake: Interface["wake"] = () => Effect.void
    const coordinator: SessionRunCoordinator.Coordinator<SessionSchema.ID, SessionRunner.RunError | ScopeUnavailableError, InterruptReason> = yield* SessionRunCoordinator.make<SessionSchema.ID, SessionRunner.RunError | ScopeUnavailableError, InterruptReason>({
      started: (sessionID) =>
        reportLifecycle(
          sessionID,
          events.publish(SessionEvent.Execution.Started, { sessionID }, clearSuspensionOnCommit(sessionID)),
        ).pipe(Effect.andThen(Effect.suspend(() => publishStatus(sessionID)))),
      afterSettled: (sessionID) => publishStatus(sessionID),
      drain: Effect.fnUntraced(function* (sessionID: SessionSchema.ID, force) {
        woken.delete(sessionID)
        stopRequested.delete(sessionID)
        drainPendingSnapshot.set(sessionID, yield* pendingInputIDs(sessionID))
        const session = yield* store.get(sessionID)
        if (!session) return yield* Effect.die(new Error(`Session not found: ${sessionID}`))
        const task = yield* db
          .select({
            state: SessionTaskTable.state,
            ownerPid: SessionTaskTable.owner_pid,
            ownerStarted: SessionTaskTable.owner_started,
          })
          .from(SessionTaskTable)
          .where(eq(SessionTaskTable.session_id, sessionID))
          .get()
          .pipe(Effect.orDie)
        if (task && task.state !== "running") {
          // Silent early return used to strand admitted prompts with no
          // trace; name the gate so "pending but idle" is diagnosable.
          yield* Effect.logWarning("Session drain skipped for non-running managed task", {
            state: task.state,
          }).pipe(Effect.annotateLogs({ sessionID }))
          return
        }
        if (task && task.ownerPid !== null && (!owner || task.ownerPid !== owner.pid || task.ownerStarted !== owner.started)) {
          yield* Effect.logWarning("Session drain skipped for a managed task claimed by another process", {
            ownerPid: task.ownerPid,
          }).pipe(Effect.annotateLogs({ sessionID }))
          return
        }
        const runnerLayer = session.scope === "standalone"
          ? yield* Effect.gen(function* () {
              const { SessionRunnerLLM } = yield* Effect.promise(() => import("./runner/llm"))
              return Layer.effectContext(locations.contextEffect(session.location, [SessionRunnerLLM.standaloneNode], session.scope).pipe(
                Effect.mapError((error) => error instanceof ScopeUnavailableError ? error : new ScopeUnavailableError({ operation: "standalone runner configuration" })),
              ))
            })
          : locations.get(session.location, [LocationServiceMap.full])
        return yield* SessionRunner.Service.use((runner) => runner.drain({ sessionID, force })).pipe(
          Effect.provide(runnerLayer),
          SessionCompactionExecution.bind(compactionExecution),
          Effect.tapCause((cause) => {
            if (Cause.hasInterruptsOnly(cause)) return Effect.void
            const maybeError = Option.getOrUndefined(Cause.findErrorOption(cause))
            const failure = (maybeError ?? Cause.squash(cause)) as unknown
            const sessionError = (() => {
              try {
                return toSessionError(failure)
              } catch {
                return undefined
              }
            })()
            const isExpectedAuth =
              failure instanceof StepFailedError
                ? failure.error.type === "provider.auth"
                : failure instanceof LLMError
                  ? failure.reason._tag === "Authentication"
                  : sessionError?.type === "provider.auth"
            if (isExpectedAuth)
              return Effect.logWarning("Session drain ended with expected auth error", cause).pipe(
                Effect.annotateLogs({ sessionID }),
              )
            return Effect.logError("Failed to drain Session", cause).pipe(Effect.annotateLogs({ sessionID }))
          }),
        )
      }),
      // One terminal observation per busy period, covering every coalesced drain.
      settled: (sessionID, exit, reason): Effect.Effect<void> =>
        Effect.gen(function* () {
          const outcome = terminal(exit, reason)
          const advanced =
            outcome.type === "interrupted"
              ? undefined
              : yield* (outcome.type === "succeeded" ? continuedGoal(sessionID) : failedGoal(sessionID, outcome.error)).pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning("Failed to continue the autonomous goal", cause).pipe(
                      Effect.annotateLogs({ sessionID }),
                      Effect.as(undefined),
                    ),
                  ),
                )
          yield* reportLifecycle(
            sessionID,
            Effect.gen(function* () {
              if (outcome.type === "succeeded") {
                yield* events.publish(
                  SessionEvent.Execution.Succeeded,
                  { sessionID },
                  clearSuspensionOnCommit(sessionID),
                )
                yield* completion.complete(sessionID, coordinator.active)
                return
              }
              if (outcome.type === "interrupted") {
                yield* events.publish(SessionEvent.Execution.Interrupted, { sessionID, reason: outcome.reason })
                return
              }
              yield* events.publish(
                SessionEvent.Execution.Failed,
                {
                  sessionID,
                  error: outcome.error,
                },
                clearSuspensionOnCommit(sessionID),
              )
            }),
          )
          yield* settleTask(sessionID, outcome).pipe(
            Effect.catchCause((cause) =>
              Effect.logError("Failed to settle managed child task", cause).pipe(Effect.annotateLogs({ sessionID })),
            ),
          )
          if (outcome.type === "failed")
            yield* retryFailedPending(sessionID).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Failed to schedule a successor drain for pending inputs", cause).pipe(
                  Effect.annotateLogs({ sessionID }),
                ),
              ),
            )
          else {
            failedPending.delete(sessionID)
            drainPendingSnapshot.delete(sessionID)
            stopRequested.delete(sessionID)
          }
          const queued =
            advanced === undefined
              ? false
              : yield* admitGoalContinuation(sessionID, advanced).pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning("Failed to queue autonomous goal continuation", cause).pipe(
                      Effect.annotateLogs({ sessionID }),
                      Effect.as(false),
                    ),
                  ),
                )
          if (queued) yield* wake(sessionID).pipe(Effect.catchTag("Session.ScopeUnavailableError", (error) => Effect.logWarning("Could not wake Session", error)))
        }),
    })

    const publishStatus = (sessionID: SessionSchema.ID): Effect.Effect<void> => coordinator.active.pipe(
      Effect.flatMap((active) => events.publish(SessionStatusEvent.Status, {
        sessionID, status: { type: active.has(sessionID) ? "busy" : "idle" },
      })),
      Effect.asVoid,
      Effect.catchCause((cause) => Effect.logWarning("Failed to publish Session status", cause).pipe(Effect.annotateLogs({ sessionID }))),
    )
    const requireOwner = (sessionID: SessionSchema.ID) => Effect.gen(function* () {
      const task = yield* db.select({ ownerPid: SessionTaskTable.owner_pid }).from(SessionTaskTable)
        .where(eq(SessionTaskTable.session_id, sessionID)).get().pipe(Effect.orDie)
      if (task && task.ownerPid !== null && !owner) return yield* new ScopeUnavailableError({ operation: "managed task owner" })
    })
    const bindCandidate = (candidate?: ShellLedger.Process) => candidate
      ? bindTaskOwner(candidate).pipe(Effect.mapError(() => new ScopeUnavailableError({ operation: "managed task owner" })))
      : Effect.void
    wake = (sessionID, candidate) => bindCandidate(candidate).pipe(Effect.andThen(requireOwner(sessionID)), Effect.andThen(Effect.sync(() => woken.add(sessionID))), Effect.andThen(coordinator.wake(sessionID)))
    return Service.of({
      prepareTask: (candidate) => bindCandidate(candidate),
      active: coordinator.active,
      interrupt: (sessionID) =>
        Effect.sync(() => stopRequested.add(sessionID)).pipe(Effect.andThen(coordinator.interrupt(sessionID, "user"))),
      resume: (sessionID, candidate) => bindCandidate(candidate).pipe(Effect.andThen(requireOwner(sessionID)), Effect.andThen(coordinator.run(sessionID))),
      wake,
      awaitIdle: coordinator.awaitIdle,
      shutdown: coordinator.shutdown("shutdown"),
      withTransition: coordinator.withTransition,
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [
    Database.node,
    SessionAutonomy.node,
    SessionCompactionExecution.node,
    SessionStore.node,
    LocationServiceMap.node,
    EventRuntime.node,
    Job.node,
  ],
})

/** Low-level compatibility layer for callers that only need durable Session recording. */
export const noopLayer = Layer.succeed(
  Service,
  Service.of({
    prepareTask: (candidate) => validateTaskOwner(candidate).pipe(Effect.mapError(() => new ScopeUnavailableError({ operation: "managed task owner" }))),
    active: Effect.succeed(new Set()),
    resume: () => Effect.void,
    wake: () => Effect.void,
    interrupt: () => Effect.void,
    awaitIdle: () => Effect.void,
    shutdown: Effect.void,
    withTransition: (_sessionID, effect) => effect,
  }),
)
