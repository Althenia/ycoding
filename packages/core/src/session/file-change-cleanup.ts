export * as SessionFileChangeCleanup from "./file-change-cleanup"

import { inArray, lt } from "drizzle-orm"
import { Context, Duration, Effect, Layer, Schedule } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { SessionExecution } from "./execution"
import { SessionFileChangeTable, SessionTable } from "./sql"

const retention = Duration.days(30)

export interface Interface {
  readonly cleanup: (now?: number) => Effect.Effect<number>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/v2/SessionFileChangeCleanup") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const execution = yield* SessionExecution.Service
    return Service.of({
      cleanup: Effect.fn("SessionFileChangeCleanup.cleanup")(function* (now = Date.now()) {
        const active = new Set(yield* execution.active)
        const sessions = yield* db
          .select({ id: SessionTable.id })
          .from(SessionTable)
          .where(lt(SessionTable.time_updated, now - Duration.toMillis(retention)))
          .all()
          .pipe(Effect.orDie)
        const expired = sessions.map((session) => session.id).filter((sessionID) => !active.has(sessionID))
        if (expired.length === 0) return 0
        return yield* db
          .delete(SessionFileChangeTable)
          .where(inArray(SessionFileChangeTable.session_id, expired))
          .returning({ sessionID: SessionFileChangeTable.session_id })
          .all()
          .pipe(Effect.orDie, Effect.map((rows) => rows.length))
      }),
    })
  }),
)

const cleanupLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const cleanup = yield* Service
    yield* cleanup.cleanup().pipe(Effect.repeat(Schedule.spaced(Duration.hours(1))), Effect.forkScoped)
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer: Layer.merge(layer, cleanupLayer.pipe(Layer.provide(layer))),
  deps: [Database.node, SessionExecution.node],
})
