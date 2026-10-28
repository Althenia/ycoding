export * as SessionRecordCleanup from "./record-cleanup"

import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { Session } from "@ycoding-ai/schema/session"
import { Database } from "../database/database"
import { UsageStage } from "../usage-stage"

const keys = {
  session_provider_request: ["request"],
  session_usage: ["model_key"],
  session_file_change: ["path"],
  session_context_exclusion: ["context_revision", "target_key"],
} as const

export const cleanup = Effect.fn("SessionRecordCleanup.cleanup")(function* (
  db: Database.Interface["db"],
  active: Effect.Effect<ReadonlySet<Session.ID>>,
  table: keyof typeof keys,
  cutoff: number,
) {
  const columns = keys[table]
  const first = sql.raw(columns[0])
  const second = columns.length === 2 ? sql.raw(columns[1]) : undefined
  let sessionCursor: { id: Session.ID; updated: number } | undefined
  let deleted = 0
  while (true) {
    const sessions = yield* db
      .all<{ id: Session.ID; updated: number }>(
        sql`
      SELECT id, time_updated AS updated FROM session WHERE time_updated < ${cutoff}
      ${sessionCursor ? sql`AND (time_updated,id) > (${sessionCursor.updated},${sessionCursor.id})` : sql``}
      ORDER BY time_updated,id LIMIT 200
    `,
      )
      .pipe(Effect.orDie)
    for (const session of sessions) {
      let cursor: { first: string | number; second?: string | number } | undefined
      while (true) {
        const batch = yield* db
          .transaction(() =>
            Effect.gen(function* () {
              const eligible = yield* db.get(
                sql`SELECT id FROM session WHERE id = ${session.id} AND time_updated < ${cutoff}`,
              )
              if (!eligible || (yield* active).has(session.id)) return { deleted: 0, cursor }
              const rows = yield* db.all<{ id: number; first: string | number; second?: string | number }>(sql`
            SELECT rowid AS id, ${first} AS first ${second ? sql`, ${second} AS second` : sql``}
            FROM ${sql.raw(table)} WHERE session_id = ${session.id}
            ${
              cursor
                ? second
                  ? sql`AND (${first},${second}) > (${cursor.first},${cursor.second})`
                  : sql`AND ${first} > ${cursor.first}`
                : sql``
            }
            ORDER BY ${first} ${second ? sql`, ${second}` : sql``} LIMIT 100
          `)
              if (rows.length === 0) return { deleted: 0, cursor }
              if (table === "session_provider_request")
                yield* UsageStage.remove(
                  db,
                  "session",
                  sql`r.session_id = ${session.id} AND r.rowid IN (${sql.join(
                    rows.map((row) => sql`${row.id}`),
                    sql`, `,
                  )})`,
                )
              yield* db.run(sql`
            DELETE FROM ${sql.raw(table)} WHERE rowid IN (${sql.join(
              rows.map((row) => sql`${row.id}`),
              sql`, `,
            )})
              AND EXISTS (SELECT 1 FROM session WHERE id = ${session.id} AND time_updated < ${cutoff})
          `)
              const removed = (yield* db.get<{ count: number }>(sql`SELECT changes() AS count`))!.count
              if (removed > 0 && table === "session_provider_request")
                yield* db.run(
                  sql`UPDATE session SET usage_pruned_through = max(coalesce(usage_pruned_through,${cutoff}),${cutoff}) WHERE id = ${session.id}`,
                )
              return { deleted: removed, cursor: rows.at(-1)! }
            }),
          )
          .pipe(Effect.orDie)
        deleted += batch.deleted
        cursor = batch.cursor
        yield* Effect.yieldNow
        if (batch.deleted < 100) break
      }
      yield* Effect.yieldNow
    }
    if (sessions.length < 200) return deleted
    sessionCursor = sessions.at(-1)!
    yield* Effect.yieldNow
  }
})
