export * as SessionOrchestrationNotifier from "./orchestration-notifier"

import { Context, Effect, Layer, Stream } from "effect"
import { and, asc, eq } from "drizzle-orm"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { KeyedMutex } from "../effect/keyed-mutex"
import { EventV2 } from "../event"
import { SessionV2 } from "../session"
import { SessionExecution } from "./execution"
import { SessionEvent } from "./event"
import { identities } from "./orchestration"
import { SessionTaskNotificationTable, SessionTaskTable } from "./sql"

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

export class Service extends Context.Service<Service, Interface>()("@ycoding/v2/SessionOrchestrationNotifier") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const events = yield* EventV2.Service
    const execution = yield* SessionExecution.Service
    const sessions = yield* SessionV2.Service

    const service = make({
      list: (limit) =>
        db
          .select({ notification: SessionTaskNotificationTable, task: SessionTaskTable })
          .from(SessionTaskNotificationTable)
          .innerJoin(SessionTaskTable, eq(SessionTaskTable.session_id, SessionTaskNotificationTable.task_session_id))
          .where(eq(SessionTaskNotificationTable.delivered, false))
          .orderBy(asc(SessionTaskNotificationTable.time_created), asc(SessionTaskNotificationTable.id))
          .limit(limit)
          .all()
          .pipe(Effect.orDie),
      deliver: (row) => {
        const notification = row.notification
        const task = row.task
        const id = identities(task.parent_id, task.parent_assistant_message_id, task.tool_call_id).notification(
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
            Effect.andThen(execution.wake(task.parent_id)),
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
  deps: [Database.node, EventV2.node, SessionExecution.node, SessionV2.node],
})
