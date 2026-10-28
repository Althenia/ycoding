export * as UsageAnalytics from "./usage-analytics"

import { Context, DateTime, Duration, Effect, Layer, Schedule } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "./database/database"
import { EventRuntime } from "./event"
import { makeGlobalNode } from "./effect/app-node"
import { SessionEvent } from "./session/event"
import { UsageAnalyticsRequestTable } from "./usage-analytics.sql"
import { RetentionSettings } from "./retention-settings"
import { UsageStage } from "./usage-stage"
import { UsageViewChange } from "./usage-view-change"

export interface Interface {
  readonly cleanup: (now?: number) => Effect.Effect<number>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/UsageAnalytics") {}

export const taskPath = Effect.fnUntraced(function* (db: Pick<Database.Interface["db"], "get">, sessionID: string) {
  const path: string[] = []
  const visited = new Set<string>()
  let cursor = sessionID
  while (true) {
    if (visited.has(cursor)) return yield* Effect.die(new Error("Cyclic task ancestry"))
    visited.add(cursor)
    const session = yield* db
      .get<{ parentID: string | null; taskID: string | null }>(
        sql`
        SELECT session.parent_id AS parentID, session_task.session_id AS taskID FROM session
        LEFT JOIN session_task ON session_task.session_id = session.id WHERE session.id = ${cursor}
      `,
      )
      .pipe(Effect.orDie)
    if (!session) return path
    if (session.taskID) path.push(cursor)
    if (!session.parentID) return path
    cursor = session.parentID
    yield* Effect.yieldNow
  }
})

export const capture = Effect.fnUntraced(function* (db: Pick<Database.Interface["db"], "get">, sessionID: string) {
  const session = yield* db
    .get<{ projectID: string; directory: string; workspaceID: string | null; updated: number }>(
      sql`
    SELECT project_id AS projectID, directory, workspace_id AS workspaceID, time_updated AS updated FROM session WHERE id = ${sessionID}
  `,
    )
    .pipe(Effect.orDie)
  if (!session) return yield* Effect.die(new Error("Usage analytics requires the request Session Location"))
  return { sessionID, ...session, taskPath: yield* taskPath(db, sessionID) } as const
})

export const Current = Context.Reference<Effect.Success<ReturnType<typeof capture>> | undefined>(
  "@ycoding/UsageAnalytics/Dimensions",
  {
    defaultValue: () => undefined,
  },
)

export const backfill = Effect.fn("UsageAnalytics.backfill")(function* (
  db: Pick<Database.Interface["db"], "get" | "all" | "run">,
) {
  let sessionAfter: string | undefined
  while (true) {
    const sessions = yield* db.all<{ id: string }>(sql`
      SELECT id FROM session ${sessionAfter === undefined ? sql`` : sql`WHERE id > ${sessionAfter}`} ORDER BY id LIMIT 200
    `)
    for (const session of sessions) {
      const path = JSON.stringify(yield* taskPath(db, session.id))
      let after = 0
      while (true) {
        const boundary = yield* db.get<{ request: number }>(sql`
          SELECT request FROM session_provider_request INDEXED BY session_provider_request_session_request_idx
          WHERE session_id = ${session.id} AND request > ${after} ORDER BY request LIMIT 1 OFFSET 9999
        `)
        yield* Effect.yieldNow
        yield* db.run(sql`
          INSERT INTO usage_analytics_request
            (id, session_id, project_id, directory, workspace_id, session_updated, agent, source, model, usage_anchor, task_path, request, attempts,
              continuation, invalidation, prompt_cache_key, cache_read_reported, tokens, cost, timing, time_created)
          SELECT r.id, r.session_id, s.project_id, s.directory, s.workspace_id, s.time_updated, r.agent, r.source, r.model, r.usage_anchor, ${path},
            r.request, r.attempts, r.continuation, r.invalidation, substr(r.prompt_cache_key, 1, 8), r.cache_read_reported,
            r.tokens, r.cost, r.timing, r.time_created
          FROM session_provider_request AS r INDEXED BY session_provider_request_session_request_idx
          JOIN session AS s ON s.id = r.session_id
          WHERE r.session_id = ${session.id} AND r.request > ${after}
            ${boundary === undefined ? sql`` : sql`AND r.request <= ${boundary.request}`}
          ON CONFLICT(id) DO NOTHING
        `)
        yield* Effect.yieldNow
        if (!boundary) break
        after = boundary.request
      }
    }
    yield* Effect.yieldNow
    if (sessions.length < 200) return
    sessionAfter = sessions.at(-1)!.id
  }
})

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const events = yield* EventRuntime.Service
    const settings = yield* RetentionSettings.Service
    yield* events.project(SessionEvent.ProviderRequestRecorded, (event) =>
      Effect.gen(function* () {
        const current = yield* Current
        const session = current ?? (yield* capture(database.db, event.data.sessionID))
        if (session.sessionID !== event.data.sessionID)
          return yield* Effect.die(new Error("Usage analytics request scope mismatch"))
        const stored = yield* database.db
          .insert(UsageAnalyticsRequestTable)
          .values({
            id: event.data.id,
            session_id: event.data.sessionID,
            project_id: session.projectID,
            directory: session.directory,
            workspace_id: session.workspaceID,
            session_updated: session.updated,
            agent: event.data.agent,
            source: event.data.source,
            model: event.data.model,
            usage_anchor: event.data.usageAnchor,
            task_path: session.taskPath,
            request: event.data.request,
            attempts: event.data.attempts,
            continuation: event.data.continuation,
            invalidation: event.data.invalidation,
            prompt_cache_key: event.data.promptCacheKey.slice(0, 8),
            cache_read_reported: event.data.cacheReadReported,
            tokens: event.data.tokens,
            cost: event.data.cost,
            timing: event.data.timing,
            outcome: event.data.outcome,
            time_created: DateTime.toEpochMillis(event.data.time),
          })
          .onConflictDoNothing()
          .returning({ id: UsageAnalyticsRequestTable.id })
          .get()
          .pipe(Effect.orDie)
        if (!stored) return
        yield* UsageStage.append(database.db, "backend", stored.id)
        yield* UsageViewChange.append(database.db, stored.id)
      }),
    )
    return Service.of({
      cleanup: Effect.fn("UsageAnalytics.cleanup")(function* (now = Date.now()) {
        const days = (yield* settings.read()).usageDays
        const cutoff = now - Duration.toMillis(Duration.days(days))
        let deleted = 0
        while (true) {
          const removed = yield* database.db
            .transaction(() =>
              Effect.gen(function* () {
                const expired = yield* database.db
                  .get<{ id: string }>(
                    sql`
          SELECT id FROM usage_analytics_request INDEXED BY usage_analytics_request_time_created_id_idx
          WHERE time_created < ${cutoff} LIMIT 1
        `,
                  )
                  .pipe(Effect.orDie)
                if (!expired) return 0
                const last = yield* database.db
                  .get<{ time: number; id: string }>(
                    sql`
          SELECT time_created AS time, id FROM usage_analytics_request INDEXED BY usage_analytics_request_time_created_id_idx
          WHERE time_created < ${cutoff} ORDER BY time_created, id LIMIT 1 OFFSET 999
        `,
                  )
                  .pipe(Effect.orDie)
                const batch = sql`r.time_created < ${cutoff} ${last ? sql`AND (r.time_created, r.id) <= (${last.time}, ${last.id})` : sql``}`
                yield* UsageViewChange.remove(database.db, batch)
                yield* UsageStage.remove(database.db, "backend", batch)
                const rows = yield* database.db
                  .all<{ id: string }>(sql`DELETE FROM usage_analytics_request AS r WHERE ${batch} RETURNING id`)
                  .pipe(Effect.orDie)
                return rows.length
              }),
            )
            .pipe(Effect.orDie)
          deleted += removed
          yield* Effect.yieldNow
          if (removed < 1000) {
            yield* UsageViewChange.collect(database.db, Date.now())
            return deleted
          }
        }
      }),
    })
  }),
)

const cleanupLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const analytics = yield* Service
    yield* analytics.cleanup()
    yield* analytics
      .cleanup()
      .pipe(Effect.repeat(Schedule.spaced(Duration.hours(1))), Effect.delay(Duration.hours(1)), Effect.forkScoped)
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer: Layer.merge(layer, cleanupLayer.pipe(Layer.provide(layer))),
  deps: [Database.node, EventRuntime.node, RetentionSettings.node],
})
