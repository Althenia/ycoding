import { expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@ycoding-ai/effect-drizzle-sqlite"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { DatabaseMigration } from "@ycoding-ai/core/database/migration"
import { SessionAutonomy } from "@ycoding-ai/core/session/autonomy"
import migration from "../src/database/migration/20261017090000_session-yolo-level"
import type { SqlClient } from "effect/unstable/sql/SqlClient"

const run = <A, E>(effect: Effect.Effect<A, E, SqlClient>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )

const rows = (db: EffectDrizzleSqlite.EffectSQLiteDatabase) =>
  db.all<{ id: string; autonomy: string | null; autonomy_revision: number }>(
    sql`SELECT id, autonomy, autonomy_revision FROM session ORDER BY id`,
  )

test("one-time migration rewrites stored YOLO 3 to 2 and nothing else", async () => {
  await run(
    Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      yield* DatabaseMigration.apply(db)
      yield* db.run(sql`
        INSERT INTO project (id, worktree, time_created, time_updated, sandboxes)
        VALUES ('global', '/project', 1, 1, '[]')
      `)
      const goal = JSON.stringify({
        mode: "normal",
        yolo: 3,
        goal: { text: "Finish", status: "active", iteration: 1, noProgress: 0, maxNoProgress: 3 },
        sleep: {},
      })
      yield* db.run(sql`
        INSERT INTO session (id, project_id, directory, title, time_created, time_updated, autonomy, autonomy_revision)
        VALUES ('ses_bool', 'global', '/project', 'bool', 1, 1, '{"mode":"yolo","yolo":true}', 4),
               ('ses_null', 'global', '/project', 'null', 1, 1, NULL, 0),
               ('ses_y1', 'global', '/project', 'one', 1, 1, '{"mode":"normal","yolo":1}', 3),
               ('ses_y2', 'global', '/project', 'two', 1, 1, '{"mode":"normal","yolo":2}', 3),
               ('ses_y3', 'global', '/project', 'three', 1, 1, '{"mode":"normal","yolo":3}', 5),
               ('ses_y3_goal', 'global', '/project', 'goal', 1, 1, ${goal}, 2)
      `)
      const before = yield* rows(db)
      yield* db.run(sql`DELETE FROM migration WHERE id = ${migration.id}`)
      yield* DatabaseMigration.apply(db)
      const after = yield* rows(db)
      const byID = new Map(after.map((row) => [row.id, row]))
      expect(JSON.parse(byID.get("ses_y3")!.autonomy!)).toEqual({ mode: "normal", yolo: 2 })
      expect(byID.get("ses_y3")!.autonomy_revision).toBe(6)
      expect(JSON.parse(byID.get("ses_y3_goal")!.autonomy!)).toEqual({ ...JSON.parse(goal), yolo: 2 })
      expect(byID.get("ses_y3_goal")!.autonomy_revision).toBe(3)
      for (const row of before) {
        if (row.id === "ses_y3" || row.id === "ses_y3_goal") continue
        expect(byID.get(row.id)).toEqual(row)
      }
      yield* DatabaseMigration.apply(db)
      expect(yield* rows(db)).toEqual(after)
      expect(yield* db.all(sql`SELECT id FROM migration WHERE id = ${migration.id}`)).toHaveLength(1)
    }),
  )
})

test("stored YOLO 3 that bypasses the migration fails closed instead of mapping to 2", () => {
  expect(SessionAutonomy.read({ mode: "normal", yolo: 3 }).yolo).toBe(0)
  expect(SessionAutonomy.read({ mode: "normal", yolo: 2 }).yolo).toBe(2)
  expect(SessionAutonomy.read({ mode: "normal", yolo: true }).yolo).toBe(2)
})
