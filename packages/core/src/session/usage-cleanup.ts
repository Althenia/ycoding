export * as SessionUsageCleanup from "./usage-cleanup"

import { and, asc, eq, gt, inArray, lt, or, sql } from "drizzle-orm"
import { Context, Duration, Effect, Layer, Schedule } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { SessionExecution } from "./execution"
import { SessionProviderRequestTable, SessionTable, SessionUsageTable } from "./sql"

const retention = Duration.days(30)

export interface Interface {
  readonly cleanup: (now?: number) => Effect.Effect<number>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/SessionUsageCleanup") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const execution = yield* SessionExecution.Service
    return Service.of({
      cleanup: Effect.fn("SessionUsageCleanup.cleanup")(function* (now = Date.now()) {
        const active = new Set(yield* execution.active)
        let cursor: { id: (typeof SessionTable.$inferSelect)["id"]; updated: number } | undefined
        let deleted = 0
        while (true) {
          const sessions = yield* db
            .select({ id: SessionTable.id, updated: SessionTable.time_updated })
            .from(SessionTable)
            .where(
              and(
                lt(SessionTable.time_updated, now - Duration.toMillis(retention)),
                cursor
                  ? or(
                      gt(SessionTable.time_updated, cursor.updated),
                      and(eq(SessionTable.time_updated, cursor.updated), gt(SessionTable.id, cursor.id)),
                    )
                  : undefined,
              ),
            )
            .orderBy(asc(SessionTable.time_updated), asc(SessionTable.id))
            .limit(200)
            .all()
            .pipe(Effect.orDie)
          const expired = sessions.map((session) => session.id).filter((id) => !active.has(id))
          if (expired.length > 0)
            deleted += yield* db
              .transaction(() =>
                Effect.gen(function* () {
                  yield* db.delete(SessionUsageTable).where(inArray(SessionUsageTable.session_id, expired)).run()
                  yield* db
                    .delete(SessionProviderRequestTable)
                    .where(inArray(SessionProviderRequestTable.session_id, expired))
                    .run()
                  return (yield* db.get<{ count: number }>(sql`SELECT changes() AS count`))!.count
                }),
              )
              .pipe(Effect.orDie)
          if (sessions.length < 200) return deleted
          cursor = sessions.at(-1)!
        }
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
