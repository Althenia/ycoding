export * as SessionExecution from "./execution"

import { Cause, Context, Effect, Exit, Layer, Option } from "effect"
import { LLMError } from "@ycoding-ai/ai"
import { EventV2 } from "../event"
import { LocationServiceMap } from "../location-service-map"
import { makeGlobalNode } from "../effect/app-node"
import { SessionEvent } from "./event"
import { SessionRunCoordinator } from "./run-coordinator"
import { SessionRunner } from "./runner/index"
import { SessionSchema } from "./schema"
import { SessionStore } from "./store"
import { toSessionError } from "./to-session-error"
import { StepFailedError, UserInterruptedError } from "./error"
import { Database } from "../database/database"
import { Hash } from "../util/hash"
import { SessionAutonomy } from "./autonomy"
import { SessionCompactionExecution } from "./compaction-execution"
import { SessionMessage } from "./message"
import { SessionPending } from "./pending"
import { SessionTaskTable } from "./sql"
import { and, eq, inArray } from "drizzle-orm"
import { SessionOrchestration } from "@ycoding-ai/schema/session-orchestration"
import { Shell } from "../shell"

export interface Interface {
  /** Snapshots active execution owned by this process. */
  readonly active: Effect.Effect<ReadonlySet<SessionSchema.ID>>
  /** Starts execution while idle or joins the active execution. */
  readonly resume: (sessionID: SessionSchema.ID) => Effect.Effect<void, SessionRunner.RunError>
  /** Registers newly recorded work. Repeated wakeups may coalesce. */
  readonly wake: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  /** Interrupt active work owned by this process. Idle interruption is a no-op. */
  readonly interrupt: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  /** Resolves once this process owns no active execution for the Session. Returns immediately when idle and never starts work. */
  readonly awaitIdle: (sessionID: SessionSchema.ID) => Effect.Effect<void>
}

/** Routes execution from a Session ID to the runner owned by that Session's Location. */
export class Service extends Context.Service<Service, Interface>()("@ycoding/v2/SessionExecution") {}

type InterruptReason = "user" | "shutdown" | "superseded"

export function terminal(exit: Exit.Exit<void, SessionRunner.RunError>, reason?: InterruptReason) {
  if (Exit.isSuccess(exit)) return { type: "succeeded" as const }
  if (Cause.hasInterrupts(exit.cause)) return { type: "interrupted" as const, reason: reason ?? "shutdown" }
  const failure = Cause.squash(exit.cause)
  if (failure instanceof UserInterruptedError) return { type: "interrupted" as const, reason: "user" as const }
  return { type: "failed" as const, error: toSessionError(failure) }
}

/** Process-local execution: drains run in this process, routed through the Session's Location graph. */
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const store = yield* SessionStore.Service
    const locations = yield* LocationServiceMap.Service
    const events = yield* EventV2.Service
    const db = (yield* Database.Service).db
    const autonomy = yield* SessionAutonomy.Service
    const compactionExecution = yield* SessionCompactionExecution.Service
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
    const continuedGoal = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
      const state = yield* autonomy
        .get(sessionID)
        .pipe(Effect.catchTag("SessionAutonomy.NotFound", () => Effect.succeed(SessionAutonomy.defaultState)))
      if (!state.goal || state.goal.status !== "active") return undefined
      const activeChild = yield* db
        .select({ sessionID: SessionTaskTable.session_id })
        .from(SessionTaskTable)
        .where(
          and(
            eq(SessionTaskTable.parent_id, sessionID),
            inArray(SessionTaskTable.state, ["starting", "running", "waiting", "cancelling"]),
          ),
        )
        .limit(1)
        .get()
        .pipe(Effect.orDie)
      if (activeChild) return undefined
      const session = yield* store.get(sessionID)
      if (!session) return undefined
      const activeShell = yield* Effect.gen(function* () {
        const shell = yield* Shell.Service
        return (yield* shell.list()).some((info) => info.metadata.sessionID === sessionID)
      }).pipe(Effect.provide(locations.get(session.location)))
      if (activeShell) return undefined
      const advanced = yield* autonomy.advance({ sessionID, progress: "" })
      if (!advanced.goal || advanced.goal.status !== "active") return undefined
      return { goal: advanced.goal, yolo: SessionAutonomy.yoloLevel(advanced) }
    })

    const admitGoalContinuation = Effect.fnUntraced(function* (
      sessionID: SessionSchema.ID,
      advanced: { readonly goal: SessionAutonomy.Goal; readonly yolo: number },
    ) {
      const id = SessionMessage.ID.make(
        `msg_goal_${Hash.sha256(`${sessionID}\0${advanced.goal.iteration}`).slice(0, 24)}`,
      )
      const input = SessionPending.Message.make({
        type: "synthetic",
        data: {
          text: SessionAutonomy.continuationPrompt(advanced.goal),
          description: "Autonomous goal continuation",
          metadata: { autonomy: { yolo: advanced.yolo, goal: true, iteration: advanced.goal.iteration } },
        },
        delivery: "steer",
      })
      return yield* SessionPending.admit(db, events, { id, sessionID, input }).pipe(
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
      const messages = yield* store.context(sessionID)
      const assistant = messages.findLast((message) => message.type === "assistant")
      const text = assistant?.content
        .filter((part): part is Extract<(typeof assistant.content)[number], { type: "text" }> => part.type === "text")
        .map((part) => part.text)
        .join("")
      const excerpt = text === undefined ? undefined : SessionOrchestration.truncateUtf8(text, 16 * 1024)
      yield* events.publish(SessionEvent.Task.Updated, {
        sessionID,
        change: { type: "completed", excerpt },
      })
    })
    let wake: (sessionID: SessionSchema.ID) => Effect.Effect<void> = () => Effect.void
    const coordinator = yield* SessionRunCoordinator.make<SessionSchema.ID, SessionRunner.RunError, InterruptReason>({
      started: (sessionID) =>
        reportLifecycle(
          sessionID,
          events.publish(SessionEvent.Execution.Started, { sessionID }, clearSuspensionOnCommit(sessionID)),
        ),
      drain: Effect.fnUntraced(function* (sessionID: SessionSchema.ID, force) {
        const session = yield* store.get(sessionID)
        if (!session) return yield* Effect.die(new Error(`Session not found: ${sessionID}`))
        const task = yield* db
          .select({ state: SessionTaskTable.state })
          .from(SessionTaskTable)
          .where(eq(SessionTaskTable.session_id, sessionID))
          .get()
          .pipe(Effect.orDie)
        if (task && task.state !== "running") return
        return yield* SessionRunner.Service.use((runner) => runner.drain({ sessionID, force })).pipe(
          Effect.provide(locations.get(session.location)),
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
      settled: (sessionID, exit, reason) =>
        Effect.gen(function* () {
          const outcome = terminal(exit, reason)
          const advanced =
            outcome.type === "succeeded"
              ? yield* continuedGoal(sessionID).pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning("Failed to continue the autonomous goal", cause).pipe(
                      Effect.annotateLogs({ sessionID }),
                      Effect.as(undefined),
                    ),
                  ),
                )
              : undefined
          yield* reportLifecycle(
            sessionID,
            Effect.gen(function* () {
              if (outcome.type === "succeeded") {
                yield* events.publish(
                  SessionEvent.Execution.Succeeded,
                  { sessionID },
                  clearSuspensionOnCommit(sessionID),
                )
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
          if (queued) yield* wake(sessionID)
        }),
    })

    wake = coordinator.wake
    return Service.of({
      active: coordinator.active,
      interrupt: (sessionID) => coordinator.interrupt(sessionID, "user"),
      resume: coordinator.run,
      wake: coordinator.wake,
      awaitIdle: coordinator.awaitIdle,
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
    EventV2.node,
  ],
})

/** Low-level compatibility layer for callers that only need durable Session recording. */
export const noopLayer = Layer.succeed(
  Service,
  Service.of({
    active: Effect.succeed(new Set()),
    resume: () => Effect.void,
    wake: () => Effect.void,
    interrupt: () => Effect.void,
    awaitIdle: () => Effect.void,
  }),
)
