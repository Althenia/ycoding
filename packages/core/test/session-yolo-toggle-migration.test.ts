import { expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@ycoding-ai/effect-drizzle-sqlite"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { DatabaseMigration } from "@ycoding-ai/core/database/migration"
import { SessionAutonomy } from "@ycoding-ai/core/session/autonomy"
import migration from "../src/database/migration/20261020120000_session-yolo-toggle"
import type { SqlClient } from "effect/unstable/sql/SqlClient"

const run = <A, E>(effect: Effect.Effect<A, E, SqlClient>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )

const rows = (db: EffectDrizzleSqlite.EffectSQLiteDatabase) =>
  db.all<{ id: string; autonomy: string | null; autonomy_revision: number }>(
    sql`SELECT id, autonomy, autonomy_revision FROM session ORDER BY id`,
  )

test("one-time migration rewrites numeric YOLO levels into boolean YOLO plus rule flags and nothing else", async () => {
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
        yolo: 2,
        goal: { text: "Finish", status: "active", iteration: 1, noProgress: 0, maxNoProgress: 3 },
        sleep: {},
        autoAnswer: true,
      })
      const activeGoal = { text: "Finish", status: "active", iteration: 1, noProgress: 0, maxNoProgress: 3 }
      const modeGoalLevel = JSON.stringify({ mode: "goal", yolo: 1, goal: activeGoal, sleep: {} })
      const modeGoalAbsent = JSON.stringify({ mode: "goal", goal: activeGoal })
      yield* db.run(sql`
        INSERT INTO session (id, project_id, directory, title, time_created, time_updated, autonomy, autonomy_revision)
        VALUES ('ses_absent', 'global', '/project', 'absent', 1, 1, '{"mode":"normal"}', 7),
               ('ses_bool_false', 'global', '/project', 'bool false', 1, 1, '{"mode":"normal","yolo":false,"autoPermission":false}', 4),
               ('ses_bool_true', 'global', '/project', 'bool true', 1, 1, '{"mode":"yolo","yolo":true}', 4),
               ('ses_normal_true', 'global', '/project', 'normal true', 1, 1, '{"mode":"normal","yolo":true,"autoAnswer":false}', 2),
               ('ses_mode_yolo_absent', 'global', '/project', 'mode yolo absent', 1, 1, '{"mode":"yolo"}', 1),
               ('ses_mode_yolo_false', 'global', '/project', 'mode yolo false', 1, 1, '{"mode":"yolo","yolo":false,"autoAnswer":true}', 6),
               ('ses_mode_goal_one', 'global', '/project', 'mode goal one', 1, 1, ${modeGoalLevel}, 3),
               ('ses_mode_goal_absent', 'global', '/project', 'mode goal absent', 1, 1, ${modeGoalAbsent}, 3),
               ('ses_null', 'global', '/project', 'null', 1, 1, NULL, 0),
               ('ses_y0', 'global', '/project', 'zero', 1, 1, '{"mode":"normal","yolo":0,"autoAnswer":true}', 3),
               ('ses_y1', 'global', '/project', 'one', 1, 1, '{"mode":"normal","yolo":1}', 3),
               ('ses_y2_goal', 'global', '/project', 'goal', 1, 1, ${goal}, 2),
               ('ses_y3', 'global', '/project', 'three', 1, 1, '{"mode":"normal","yolo":3}', 5),
               ('ses_y7', 'global', '/project', 'seven', 1, 1, '{"mode":"normal","yolo":7}', 1),
               ('ses_yneg', 'global', '/project', 'neg', 1, 1, '{"mode":"normal","yolo":-1}', 1)
      `)
      const before = yield* rows(db)
      yield* db.run(sql`DELETE FROM migration WHERE id = ${migration.id}`)
      yield* DatabaseMigration.apply(db)
      const after = yield* rows(db)
      const byID = new Map(after.map((row) => [row.id, row]))
      const parse = (id: string) => JSON.parse(byID.get(id)!.autonomy!)
      expect(parse("ses_y0")).toEqual({ mode: "normal", yolo: false, autoAnswer: true })
      expect(byID.get("ses_y0")!.autonomy_revision).toBe(4)
      expect(parse("ses_y1")).toEqual({ mode: "normal", yolo: false, autoPermission: true })
      expect(byID.get("ses_y1")!.autonomy_revision).toBe(4)
      expect(parse("ses_y2_goal")).toEqual({ ...JSON.parse(goal), yolo: false, autoPermission: true, autoGuardrail: true })
      expect(byID.get("ses_y2_goal")!.autonomy_revision).toBe(3)
      expect(parse("ses_y3")).toEqual({ mode: "normal", yolo: false, autoPermission: true, autoGuardrail: true })
      expect(byID.get("ses_y3")!.autonomy_revision).toBe(6)
      const both = { yolo: false, autoPermission: true, autoGuardrail: true }
      expect(parse("ses_bool_true")).toEqual({ mode: "normal", ...both })
      expect(byID.get("ses_bool_true")!.autonomy_revision).toBe(5)
      expect(parse("ses_normal_true")).toEqual({ mode: "normal", autoAnswer: false, ...both })
      expect(byID.get("ses_normal_true")!.autonomy_revision).toBe(3)
      expect(parse("ses_mode_yolo_absent")).toEqual({ mode: "normal", ...both })
      expect(byID.get("ses_mode_yolo_absent")!.autonomy_revision).toBe(2)
      expect(parse("ses_mode_yolo_false")).toEqual({ mode: "normal", autoAnswer: true, ...both })
      expect(byID.get("ses_mode_yolo_false")!.autonomy_revision).toBe(7)
      expect(parse("ses_mode_goal_one")).toEqual({ mode: "normal", yolo: false, autoPermission: true, goal: activeGoal, sleep: {} })
      expect(byID.get("ses_mode_goal_one")!.autonomy_revision).toBe(4)
      expect(parse("ses_mode_goal_absent")).toEqual({ mode: "normal", yolo: false, goal: activeGoal })
      expect(byID.get("ses_mode_goal_absent")!.autonomy_revision).toBe(4)
      expect(parse("ses_y7")).toEqual({ mode: "normal", yolo: false })
      expect(byID.get("ses_y7")!.autonomy_revision).toBe(2)
      expect(parse("ses_yneg")).toEqual({ mode: "normal", yolo: false })
      expect(byID.get("ses_yneg")!.autonomy_revision).toBe(2)
      for (const row of before) {
        if (["ses_bool_true", "ses_normal_true", "ses_mode_yolo_absent", "ses_mode_yolo_false", "ses_mode_goal_one", "ses_mode_goal_absent", "ses_y0", "ses_y1", "ses_y2_goal", "ses_y3", "ses_y7", "ses_yneg"].includes(row.id)) continue
        expect(byID.get(row.id)).toEqual(row)
      }
      yield* DatabaseMigration.apply(db)
      expect(yield* rows(db)).toEqual(after)
      expect(yield* db.all(sql`SELECT id FROM migration WHERE id = ${migration.id}`)).toHaveLength(1)
    }),
  )
})

test("stored numeric YOLO that bypasses the migration fails closed instead of granting flags", () => {
  for (const yolo of [0, 1, 2, 3, -1, 7]) {
    const state = SessionAutonomy.read({ mode: "normal", yolo })
    expect(state.yolo).toBe(false)
    expect(state.autoPermission).toBeUndefined()
    expect(state.autoGuardrail).toBeUndefined()
  }
  expect(SessionAutonomy.read({ mode: "normal", yolo: true }).yolo).toBe(true)
  expect(SessionAutonomy.read({ mode: "normal", yolo: false }).yolo).toBe(false)
  expect(SessionAutonomy.read({ mode: "yolo" })).toEqual({ mode: "normal", yolo: false })
  expect(SessionAutonomy.read({ mode: "goal", yolo: 2 })).toEqual({ mode: "normal", yolo: false })
  expect(SessionAutonomy.read({ mode: "normal" })).toEqual({ mode: "normal", yolo: false })
  expect(SessionAutonomy.read({ mode: "normal", yolo: true, autoPermission: true, autoGuardrail: false }))
    .toEqual({ mode: "normal", yolo: true, autoPermission: true, autoGuardrail: false })
})
