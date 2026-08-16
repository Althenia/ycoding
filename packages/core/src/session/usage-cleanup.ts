export * as SessionUsageCleanup from "./usage-cleanup"

import { and, inArray, lt } from "drizzle-orm"
import { Context, Duration, Effect, Layer, Schedule } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { SessionExecution } from "./execution"
import { SessionProviderRequestTable, SessionTable, SessionUsageTable } from "./sql"

const retention = Duration.days(30)

export interface Interface {
  readonly cleanup: (now?: number) => Effect.Effect<number>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/v2/SessionUsageCleanup") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const execution = yield* SessionExecution.Service
    return Service.of({
      cleanup: Effect.fn("SessionUsageCleanup.cleanup")(function* (now = Date.now()) {
        const active = new Set(yield* execution.active)
        const expired = (yield* db
          .select({ id: SessionTable.id })
          .from(SessionTable)
          .where(and(lt(SessionTable.time_updated, now - Duration.toMillis(retention))))
          .all()
          .pipe(Effect.orDie))
          .map((session) => session.id)
          .filter((sessionID) => !active.has(sessionID))
        if (expired.length === 0) return 0
        yield* db.delete(SessionUsageTable).where(inArray(SessionUsageTable.session_id, expired)).run().pipe(Effect.orDie)
        return yield* db
          .delete(SessionProviderRequestTable)
          .where(inArray(SessionProviderRequestTable.session_id, expired))
          .returning({ id: SessionProviderRequestTable.id })
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
