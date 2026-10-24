import { expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@ycoding-ai/effect-drizzle-sqlite"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import type { SqlClient } from "effect/unstable/sql/SqlClient"
import { DatabaseMigration } from "@ycoding-ai/core/database/migration"
import { SessionAutonomy } from "@ycoding-ai/core/session/autonomy"
import migration from "../src/database/migration/20261024120000_session-decision-modes"

const run = <A, E>(effect: Effect.Effect<A, E, SqlClient>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )

const rows = (db: EffectDrizzleSqlite.EffectSQLiteDatabase) =>
  db.all<{ id: string; autonomy: string | null; autonomy_revision: number }>(
    sql`SELECT id, autonomy, autonomy_revision FROM session ORDER BY id`,
  )

const goal = { text: "Finish", status: "active", iteration: 1, noProgress: 0, maxNoProgress: 3 }
const legacy: ReadonlyArray<readonly [string, unknown, Record<string, unknown> | undefined]> = [
  ["ses_off", { mode: "normal", yolo: false }, { permissions: "manual", guardrails: "manual", answers: "manual" }],
  ["ses_false_flags", { mode: "normal", yolo: false, autoPermission: false, autoGuardrail: false, autoAnswer: false },
    { permissions: "manual", guardrails: "manual", answers: "manual" }],
  ["ses_yolo", { mode: "normal", yolo: true }, { permissions: "yolo", guardrails: "yolo", answers: "yolo" }],
  ["ses_yolo_false_flags", { mode: "normal", yolo: true, autoPermission: false, autoGuardrail: false, autoAnswer: false },
    { permissions: "yolo", guardrails: "yolo", answers: "yolo" }],
  ["ses_yolo_permission", { mode: "normal", yolo: true, autoPermission: true }, { permissions: "auto", guardrails: "yolo", answers: "yolo" }],
  ["ses_guardrail_only", { mode: "normal", yolo: false, autoGuardrail: true }, { permissions: "manual", guardrails: "auto", answers: "manual" }],
  ["ses_answer_yolo", { mode: "normal", yolo: true, autoAnswer: true }, { permissions: "yolo", guardrails: "yolo", answers: "auto" }],
  ["ses_all_auto", { mode: "normal", yolo: false, autoPermission: true, autoGuardrail: true, autoAnswer: true },
    { permissions: "auto", guardrails: "auto", answers: "auto" }],
  ["ses_goal_sleep", { mode: "normal", yolo: true, autoAnswer: true, goal, sleep: {} },
    { permissions: "yolo", guardrails: "yolo", answers: "auto", goal, sleep: {} }],
  ["ses_string_flags", { mode: "normal", yolo: "true", autoPermission: "true", autoGuardrail: 1, autoAnswer: null },
    { permissions: "manual", guardrails: "manual", answers: "manual" }],
  ["ses_numeric_yolo", { mode: "normal", yolo: 2, autoAnswer: true }, { permissions: "manual", guardrails: "manual", answers: "auto" }],
  ["ses_absent", { mode: "normal" }, { permissions: "manual", guardrails: "manual", answers: "manual" }],
  ["ses_legacy_mode", { mode: "yolo", yolo: true }, { permissions: "yolo", guardrails: "yolo", answers: "yolo" }],
  ["ses_current", { mode: "normal", permissions: "auto", guardrails: "manual", answers: "yolo" }, undefined],
  ["ses_null", null, undefined],
]

test("one-time migration converts legacy flags to per-category decision modes", async () => {
  await run(
    Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      yield* DatabaseMigration.apply(db)
      yield* db.run(sql`INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES ('global', '/project', 1, 1, '[]')`)
      for (const [id, value] of legacy) {
        const stored = value === null ? null : JSON.stringify(value)
        yield* db.run(sql`
          INSERT INTO session (id, project_id, directory, title, time_created, time_updated, autonomy, autonomy_revision)
          VALUES (${id}, 'global', '/project', ${id}, 1, 1, ${stored}, 5)
        `)
      }
      const before = new Map((yield* rows(db)).map((row) => [row.id, row]))
      yield* db.run(sql`DELETE FROM migration WHERE id = ${migration.id}`)
      yield* DatabaseMigration.apply(db)
      const after = yield* rows(db)
      const byID = new Map(after.map((row) => [row.id, row]))
      for (const [id, , expected] of legacy) {
        const row = byID.get(id)!
        if (expected === undefined) {
          expect(row).toEqual(before.get(id)!)
          continue
        }
        expect(JSON.parse(row.autonomy!)).toEqual({ mode: "normal", ...expected })
        expect(row.autonomy_revision).toBe(6)
        expect<unknown>(SessionAutonomy.read(JSON.parse(row.autonomy!))).toEqual({ mode: "normal", ...expected })
      }
      yield* DatabaseMigration.apply(db)
      expect(yield* rows(db)).toEqual(after)
      expect(yield* db.all(sql`SELECT id FROM migration WHERE id = ${migration.id}`)).toHaveLength(1)
    }),
  )
})

test("the decision-mode migration runs after every earlier autonomy migration", async () => {
  await run(
    Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      yield* DatabaseMigration.apply(db)
      const applied = yield* db.all<{ id: string }>(sql`SELECT id FROM migration ORDER BY id`)
      const ids = applied.map((row) => row.id)
      expect(ids.at(-1)! >= migration.id).toBe(true)
      expect(ids.indexOf(migration.id)).toBeGreaterThan(ids.indexOf("20261020120000_session-yolo-toggle"))
    }),
  )
})
