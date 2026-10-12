import { expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@ycoding-ai/effect-drizzle-sqlite"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { DatabaseMigration } from "@ycoding-ai/core/database/migration"
import { SessionSchema } from "@ycoding-ai/core/session/schema"
import { SessionTable } from "@ycoding-ai/core/session/sql"
import { migrations } from "../src/database/migration.gen"
import previousSchema from "./fixture/database-current-2026-07-25"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"

const run = <A, E>(effect: Effect.Effect<A, E, SqlClientService>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )

function activeGoals(db: EffectDrizzleSqlite.EffectSQLiteDatabase) {
  return db
    .select({ sessionID: SessionTable.id })
    .from(SessionTable)
    .where(sql`json_extract(${SessionTable.autonomy}, '$.goal.status') = 'active'`)
}

function expectSelectivePlan(db: EffectDrizzleSqlite.EffectSQLiteDatabase) {
  return Effect.gen(function* () {
    const query = activeGoals(db).toSQL()
    expect(query.params).toEqual([])
    const plan = yield* db.all<{ detail: string }>(sql.raw(`EXPLAIN QUERY PLAN ${query.sql}`))
    expect(plan.some((row) => row.detail.includes("USING INDEX session_active_goal_idx"))).toBe(true)
    expect(plan.some((row) => /^SCAN session$/.test(row.detail))).toBe(false)
  })
}

test("selects active goals through the partial index as goal status changes", async () => {
  await run(
    Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      yield* DatabaseMigration.apply(db)
      expect(yield* activeGoals(db).all()).toEqual([])
      yield* expectSelectivePlan(db)
      yield* db.run(sql`
        INSERT INTO project (id, worktree, time_created, time_updated, sandboxes)
        VALUES ('global', '/project', 1, 1, '[]')
      `)
      yield* Effect.forEach(["active", "completed", "stopped", "exhausted", "absent", "null"], (status) =>
        db.run(sql`
          INSERT INTO session (id, project_id, directory, title, time_created, time_updated, autonomy)
          VALUES (${`ses_${status}`}, 'global', '/project', 'Goal fixture', 1, 1,
            ${status === "null" ? null : JSON.stringify(status === "absent" ? {} : { goal: { status } })})
        `),
      )
      expect(yield* activeGoals(db).all()).toEqual([{ sessionID: SessionSchema.ID.make("ses_active") }])
      yield* expectSelectivePlan(db)
      yield* db.run(sql`UPDATE session SET autonomy = '{"goal":{"status":"completed"}}' WHERE id = 'ses_active'`)
      yield* db.run(sql`UPDATE session SET autonomy = '{"goal":{"status":"active"}}' WHERE id = 'ses_stopped'`)
      expect(yield* activeGoals(db).all()).toEqual([{ sessionID: SessionSchema.ID.make("ses_stopped") }])
      yield* expectSelectivePlan(db)
      yield* db.run(sql`UPDATE session SET autonomy = NULL WHERE id = 'ses_stopped'`)
      expect(yield* activeGoals(db).all()).toEqual([])
      expect(yield* db.get(sql`SELECT count(*) AS count FROM session`)).toEqual({ count: 6 })
    }),
  )
})

test("migrates an existing current-format database once without changing records or history", async () => {
  await run(
    Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      yield* db.transaction((tx) =>
        Effect.gen(function* () {
          yield* previousSchema.up(tx)
          yield* tx.run(sql`CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`)
          yield* Effect.forEach(
            migrations.filter((item) => item.id <= "20260803011247_session-usage"),
            (item) => tx.run(sql`INSERT INTO migration VALUES (${item.id}, 1)`),
          )
          yield* tx.run(sql`CREATE TABLE database_format (id TEXT PRIMARY KEY, time_created INTEGER NOT NULL)`)
          yield* tx.run(sql`INSERT INTO database_format VALUES ('current-2026-07-25', 1)`)
        }),
      )
      yield* DatabaseMigration.applyOnly(
        db,
        migrations.filter((item) => !item.id.endsWith("_session-active-goal")),
      )
      expect(yield* db.get(sql`SELECT id FROM database_format`)).toEqual({ id: "current-2026-08-04" })
      expect(yield* db.get(sql`SELECT name FROM sqlite_master WHERE name = 'session_active_goal_idx'`)).toBeUndefined()
      yield* db.run(sql`PRAGMA foreign_keys = ON`)
      yield* db.run(sql`
        INSERT INTO project (id, worktree, time_created, time_updated, sandboxes)
        VALUES ('global', '/project', 1, 1, '[]')
      `)
      yield* db.run(sql`
        INSERT INTO session (id, project_id, directory, title, time_created, time_updated, autonomy)
        VALUES ('ses_retained', 'global', '/project', 'Retained goal', 1, 2, '{"goal":{"status":"active"}}'),
               ('ses_inactive', 'global', '/project', 'Retained inactive', 3, 4, '{"goal":{"status":"completed"}}')
      `)
      yield* db.run(sql`
        INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
        VALUES ('msg_retained', 'ses_retained', 'user', 1, 1, 1, '{"content":[]}')
      `)
      yield* db.run(sql`INSERT INTO event_sequence (aggregate_id, seq) VALUES ('ses_retained', 1)`)
      yield* db.run(sql`
        INSERT INTO event (id, aggregate_id, seq, created, type, data)
        VALUES ('evt_retained', 'ses_retained', 1, 1, 'session.created.1', '{"sessionID":"ses_retained"}')
      `)
      const sessions = yield* db.all(sql`SELECT * FROM session ORDER BY id`)
      const messages = yield* db.all(sql`SELECT * FROM session_message ORDER BY id`)
      const events = yield* db.all(sql`SELECT * FROM event ORDER BY id`)
      const sequences = yield* db.all(sql`SELECT * FROM event_sequence ORDER BY aggregate_id`)
      const completed = yield* db.all(sql`SELECT * FROM migration ORDER BY id`)
      const format = yield* db.get(sql`SELECT * FROM database_format`)
      yield* DatabaseMigration.apply(db)
      yield* DatabaseMigration.apply(db)
      expect(yield* activeGoals(db).all()).toEqual([{ sessionID: SessionSchema.ID.make("ses_retained") }])
      yield* expectSelectivePlan(db)
      expect(yield* db.all(sql`SELECT * FROM session ORDER BY id`)).toEqual(sessions)
      expect(yield* db.all(sql`SELECT * FROM session_message ORDER BY id`)).toEqual(messages)
      expect(yield* db.all(sql`SELECT * FROM event ORDER BY id`)).toEqual(events)
      expect(yield* db.all(sql`SELECT * FROM event_sequence ORDER BY aggregate_id`)).toEqual(sequences)
      expect(yield* db.get(sql`SELECT * FROM database_format`)).toEqual(format)
      expect(yield* db.all(sql`SELECT * FROM migration WHERE id NOT LIKE '%_session-active-goal' ORDER BY id`)).toEqual(
        completed,
      )
      const added = yield* db.all<{ id: string }>(sql`SELECT id FROM migration WHERE id LIKE '%_session-active-goal'`)
      expect(added).toHaveLength(1)
      expect(yield* db.all(sql`PRAGMA foreign_key_check`)).toEqual([])
    }),
  )
})
