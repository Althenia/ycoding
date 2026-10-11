export * as SessionOrchestrationNotifier from "./orchestration-notifier"

import { Context, Effect, Layer, Schema, Stream } from "effect"
import { and, asc, eq, not } from "drizzle-orm"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { KeyedMutex } from "../effect/keyed-mutex"
import { EventRuntime } from "../event"
import { Session } from "../session"
import { SessionExecution } from "./execution"
import { SessionEvent } from "./event"
import { SessionOrchestrationIdentity } from "./orchestration-identity"
import { SessionTaskNotificationTable, SessionTaskTable } from "./sql"
import { SessionTask } from "./task"
import { SessionSchema } from "./schema"

export const NotificationBatchSize = 100
export type DeliveryResult = "admitted" | "retry" | "quarantined"

export interface Interface {
  readonly dispatch: Effect.Effect<void>
}

export function make<Row, E, R>(dependencies: {
  readonly list: (limit: number) => Effect.Effect<ReadonlyArray<Row>, E, R>
  readonly deliver: (row: Row) => Effect.Effect<DeliveryResult, E, R>
  readonly markDelivered: (row: Row) => Effect.Effect<void, E, R>
}) {
  const lock = KeyedMutex.makeUnsafe<string>()
  const dispatch = lock.withLock("outbox")(
    Effect.gen(function* () {
      while (true) {
        const rows = yield* dependencies.list(NotificationBatchSize)
        let finalized = 0
        for (const row of rows) {
          const result = yield* dependencies.deliver(row)
          if (result === "retry") continue
          yield* dependencies.markDelivered(row)
          finalized++
        }
        if (rows.length < NotificationBatchSize || finalized === 0) return
        yield* Effect.yieldNow
      }
    }),
  )
  return { dispatch }
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/SessionOrchestrationNotifier") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const events = yield* EventRuntime.Service
    const execution = yield* SessionExecution.Service
    const sessions = yield* Session.Service

    const lock = KeyedMutex.makeUnsafe<string>()
    const notifier = (parentID?: SessionSchema.ID) => make({
      list: (limit) =>
        db
          .select({ notification: SessionTaskNotificationTable, task: SessionTaskTable })
          .from(SessionTaskNotificationTable)
          .innerJoin(SessionTaskTable, eq(SessionTaskTable.session_id, SessionTaskNotificationTable.task_session_id))
          .where(and(
            eq(SessionTaskNotificationTable.delivered, false),
            parentID === undefined
              ? not(SessionTask.restartLoss(db))
              : and(eq(SessionTaskNotificationTable.parent_id, parentID), SessionTask.restartLoss(db)),
          ))
          .orderBy(asc(SessionTaskNotificationTable.time_created), asc(SessionTaskNotificationTable.id))
          .limit(limit)
          .all()
          .pipe(Effect.orDie),
      deliver: (row) => {
        const notification = row.notification
        const task = row.task
        const id = SessionOrchestrationIdentity.launch(task.parent_id, task.parent_assistant_message_id, task.tool_call_id).notification(
          notification.revision,
          notification.type,
        )
        const data = {
          source: "subagent_notification",
          childID: task.session_id,
          type: notification.type,
          revision: notification.revision,
          excerpt: notification.excerpt ?? undefined,
        }
        return sessions
          .synthetic({
            id,
            sessionID: task.parent_id,
            text: `Subagent notification:\n${JSON.stringify(data)}`,
            description: "Subagent notification",
            metadata: data,
            delivery: "steer",
            resume: false,
          })
          .pipe(
            Effect.andThen(parentID === undefined ? execution.wake(task.parent_id) : Effect.void),
            Effect.as("admitted" as const),
            Effect.catchTag("Session.NotFoundError", () =>
              Effect.logWarning("Parent Session missing for subagent notification").pipe(
                Effect.annotateLogs({ parentID: task.parent_id, childID: task.session_id }),
                Effect.as("retry" as const),
              ),
            ),
            Effect.catchTag("Session.SyntheticConflictError", () =>
              Effect.logError("Deterministic subagent notification conflicts with parent history").pipe(
                Effect.annotateLogs({
                  parentID: task.parent_id,
                  childID: task.session_id,
                  notification: notification.id,
                }),
                Effect.as("quarantined" as const),
              ),
            ),
          )
      },
      markDelivered: (row) =>
        db
          .update(SessionTaskNotificationTable)
          .set({ delivered: true, time_delivered: Date.now() })
          .where(
            and(
              eq(SessionTaskNotificationTable.id, row.notification.id),
              eq(SessionTaskNotificationTable.delivered, false),
            ),
          )
          .run()
          .pipe(Effect.orDie, Effect.asVoid),
    })
    const service = { dispatch: lock.withLock("outbox")(notifier().dispatch) }

    const unsubscribe = yield* events.listen((event) =>
      event.type === SessionEvent.Execution.Started.type
        ? lock.withLock("outbox")(notifier(Schema.decodeUnknownSync(SessionEvent.Execution.Started.data)(event.data).sessionID).dispatch)
        : Effect.void,
    )
    yield* Effect.addFinalizer(() => unsubscribe)

    yield* events.subscribe(SessionEvent.Task.Updated).pipe(
      Stream.runForEach(() => service.dispatch),
      Effect.forkScoped({ startImmediately: true }),
    )
    yield* service.dispatch.pipe(Effect.forkScoped({ startImmediately: true }))
    return Service.of(service)
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, EventRuntime.node, SessionExecution.node, Session.node],
})
