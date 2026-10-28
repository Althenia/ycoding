export * as UsageViewChange from "./usage-view-change"

import { Effect } from "effect"
import { sql, type SQL } from "drizzle-orm"
import type { Database } from "./database/database"

type Db = Pick<Database.Interface["db"], "run" | "get">

export const limits = { batch: 10_000, idleMs: 3_600_000 } as const

export const append = (db: Db, id: string) =>
  db.run(sql`INSERT INTO usage_view_change (kind, source) VALUES ('append', ${id})`).pipe(Effect.orDie)

export const remove = (db: Db, predicate: SQL) =>
  db
    .run(
      sql`INSERT INTO usage_view_change (kind, through)
    SELECT 'remove', max(r.time_created) FROM usage_analytics_request AS r WHERE ${predicate} HAVING count(*) > 0`,
    )
    .pipe(Effect.orDie)

export const head = (db: Pick<Database.Interface["db"], "get">) =>
  db
    .get<{ seq: number }>(
      sql`SELECT coalesce((SELECT seq FROM sqlite_sequence WHERE name = 'usage_view_change'), 0) AS seq`,
    )
    .pipe(Effect.orDie, Effect.map((row) => row?.seq ?? 0))

export const pruned = (db: Pick<Database.Interface["db"], "get">) =>
  db
    .get<{ pruned: number }>(sql`SELECT coalesce((SELECT pruned FROM usage_view_journal WHERE id = 1), 0) AS pruned`)
    .pipe(Effect.orDie, Effect.map((row) => row?.pruned ?? 0))

export const collect = Effect.fnUntraced(function* (db: Db, now: number) {
  yield* db
    .run(
      sql`UPDATE usage_view_state SET status = 'pending'
    WHERE status IN ('ready', 'building') AND time_used < ${now - limits.idleMs}`,
    )
    .pipe(Effect.orDie)
  const consumer = yield* db
    .get<{ floor: number | null }>(
      sql`SELECT min(applied_seq) AS floor FROM usage_view_state WHERE status IN ('ready', 'building')`,
    )
    .pipe(Effect.orDie)
  const floor = consumer?.floor ?? (yield* head(db))
  while (true) {
    yield* db
      .run(
        sql`DELETE FROM usage_view_change WHERE seq IN (
        SELECT seq FROM usage_view_change WHERE seq <= ${floor} ORDER BY seq LIMIT ${limits.batch})`,
      )
      .pipe(Effect.orDie)
    const removed = yield* db.get<{ count: number }>(sql`SELECT changes() AS count`).pipe(Effect.orDie)
    yield* Effect.yieldNow
    if ((removed?.count ?? 0) < limits.batch) break
  }
  yield* db
    .run(
      sql`INSERT INTO usage_view_journal (id, pruned) VALUES (1, ${floor})
    ON CONFLICT (id) DO UPDATE SET pruned = max(pruned, excluded.pruned)`,
    )
    .pipe(Effect.orDie)
})
