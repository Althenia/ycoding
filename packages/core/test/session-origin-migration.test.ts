import { expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@ycoding-ai/effect-drizzle-sqlite"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import type { SqlClient } from "effect/unstable/sql/SqlClient"
import { DatabaseMigration } from "@ycoding-ai/core/database/migration"
import { migrations } from "../src/database/migration.gen"
import { KVTable } from "../src/kv/sql"
import { fromRow } from "../src/session/info"
import { SessionSchema } from "../src/session/schema"
import { SessionTable } from "../src/session/sql"
import previousSchema from "./fixture/database-current-2026-07-25"

const migration = migrations.find((item) => item.id.endsWith("_session-origin"))

const mapped = [
  "ses_thread",
  "ses_thread_project",
  "ses_unattributed",
  "ses_twice",
  "ses_dotted_environment",
] as const
const unmapped = [
  "ses_ordinary",
  "ses_same_title",
  "ses_replaced_mapping",
  "ses_lookalike_prefix",
  "ses_lookalike_suffix",
  "ses_lookalike_case",
  "ses_lookalike_wildcard",
  "ses_no_thread",
  "ses_empty_environment",
  "ses_empty_thread",
  "ses_empty_unattributed",
  "ses_unattributed_prefix",
  "ses_not_json",
  "ses_array_value",
  "ses_string_value",
  "ses_numeric_session",
  "ses_missing_field",
  "ses_wrong_field_case",
  "ses_nested_session",
] as const

const mappings: ReadonlyArray<readonly [string, string]> = [
  ["dots.cca.thread.environment.thread-a", JSON.stringify({ sessionID: "ses_thread" })],
  ["dots.cca.thread.environment.thread-b", JSON.stringify({ sessionID: "ses_thread_project", projectID: "prj_synthetic" })],
  ["dots.cca.unattributed.environment", JSON.stringify({ sessionID: "ses_unattributed" })],
  ["dots.cca.thread.environment.thread-c", JSON.stringify({ sessionID: "ses_twice" })],
  ["dots.cca.thread.environment.thread-d", JSON.stringify({ sessionID: "ses_twice" })],
  ["dots.cca.thread.env.with.dots.thread-e", JSON.stringify({ sessionID: "ses_dotted_environment" })],
  ["dots.cca.thread.environment.thread-missing", JSON.stringify({ sessionID: "ses_absent" })],
  ["dots.cca.threadx.environment.thread", JSON.stringify({ sessionID: "ses_lookalike_prefix" })],
  ["xdots.cca.thread.environment.thread", JSON.stringify({ sessionID: "ses_lookalike_suffix" })],
  ["DOTS.CCA.THREAD.environment.thread", JSON.stringify({ sessionID: "ses_lookalike_case" })],
  ["dotsXccaXthread.environment.thread", JSON.stringify({ sessionID: "ses_lookalike_wildcard" })],
  ["dots.cca.thread.environment", JSON.stringify({ sessionID: "ses_no_thread" })],
  ["dots.cca.thread..thread", JSON.stringify({ sessionID: "ses_empty_environment" })],
  ["dots.cca.thread.environment.", JSON.stringify({ sessionID: "ses_empty_thread" })],
  ["dots.cca.unattributed.", JSON.stringify({ sessionID: "ses_empty_unattributed" })],
  ["dots.cca.unattributedx.environment", JSON.stringify({ sessionID: "ses_unattributed_prefix" })],
  ["dots.cca.thread.environment.thread-f", "not json"],
  ["dots.cca.thread.environment.thread-g", JSON.stringify(["ses_array_value"])],
  ["dots.cca.thread.environment.thread-h", JSON.stringify("ses_string_value")],
  ["dots.cca.thread.environment.thread-i", JSON.stringify({ sessionID: 7 })],
  ["dots.cca.thread.environment.thread-j", JSON.stringify({ projectID: "ses_missing_field" })],
  ["dots.cca.thread.environment.thread-k", JSON.stringify({ SessionID: "ses_wrong_field_case" })],
  ["dots.cca.thread.environment.thread-l", JSON.stringify({ wrapper: { sessionID: "ses_nested_session" } })],
]

const run = <A, E>(effect: Effect.Effect<A, E, SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped))

test("the origin migration is registered", () => {
  expect(migration).toBeDefined()
})

test("backfill marks only Sessions an exact Dots executor mapping targets", async () => {
  await run(
    Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      yield* db.run(sql.raw("CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT NOT NULL, time_updated INTEGER NOT NULL)"))
      yield* db.run(sql.raw("CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)"))
      for (const id of [...mapped, ...unmapped]) {
        const title = id === "ses_same_title" ? "Dots · unattributed" : id
        yield* db.run(sql`INSERT INTO session (id, title, time_updated) VALUES (${id}, ${title}, 7)`)
      }
      for (const [key, value] of mappings) yield* db.run(sql`INSERT INTO kv (key, value) VALUES (${key}, ${value})`)
      const before = yield* db.all(sql`SELECT id, title, time_updated FROM session ORDER BY id`)
      const kv = yield* db.all(sql`SELECT key, value FROM kv ORDER BY key`)

      yield* DatabaseMigration.applyOnly(db, [migration!])

      const rows = yield* db.all<{ id: string; origin: string | null }>(sql`SELECT id, origin FROM session ORDER BY id`)
      expect(rows.filter((row) => row.origin === "dots-executor").map((row) => row.id)).toEqual([...mapped].sort())
      expect(rows.filter((row) => row.origin !== "dots-executor").map((row) => [row.id, row.origin])).toEqual(
        [...unmapped].sort().map((id) => [id, null]),
      )
      expect(yield* db.all(sql`SELECT id, title, time_updated FROM session ORDER BY id`)).toEqual(before)
      expect(yield* db.all(sql`SELECT key, value FROM kv ORDER BY key`)).toEqual(kv)
      expect(yield* db.all(sql`SELECT id FROM session WHERE id = 'ses_absent'`)).toEqual([])

    }),
  )
})

test("a marked Session keeps its stored origin after its mapping is later replaced or removed", async () => {
  await run(
    Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      yield* db.run(sql.raw("CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT NOT NULL)"))
      yield* db.run(sql.raw("CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)"))
      for (const id of ["ses_thread", "ses_unattributed", "ses_ordinary"])
        yield* db.run(sql`INSERT INTO session (id, title) VALUES (${id}, ${id})`)
      yield* db.run(sql`INSERT INTO kv (key, value) VALUES ('dots.cca.thread.environment.thread-a', ${JSON.stringify({ sessionID: "ses_thread" })})`)
      yield* db.run(sql`INSERT INTO kv (key, value) VALUES ('dots.cca.unattributed.environment', ${JSON.stringify({ sessionID: "ses_unattributed" })})`)
      yield* DatabaseMigration.applyOnly(db, [migration!])
      yield* db.run(sql`UPDATE kv SET value = ${JSON.stringify({ sessionID: "ses_ordinary" })} WHERE key = 'dots.cca.thread.environment.thread-a'`)
      yield* db.run(sql`DELETE FROM kv WHERE key = 'dots.cca.unattributed.environment'`)
      expect(yield* db.all(sql`SELECT id, origin FROM session ORDER BY id`)).toEqual([
        { id: "ses_ordinary", origin: null },
        { id: "ses_thread", origin: "dots-executor" },
        { id: "ses_unattributed", origin: "dots-executor" },
      ])
    }),
  )
})

test("upgrading a populated pre-origin database marks only current mapping targets and leaves a replaced historical target visible", async () => {
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
      yield* DatabaseMigration.applyOnly(db, migrations.filter((item) => !item.id.endsWith("_session-origin")))
      const columns = yield* db.all<{ name: string }>(sql`SELECT name FROM pragma_table_info('session')`)
      expect(columns.map((column) => column.name)).not.toContain("origin")

      yield* db.run(sql`PRAGMA foreign_keys = ON`)
      yield* db.run(sql`INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES ('global', '/project', 1, 1, '[]')`)
      const titles = {
        ses_historical: "Dots · executor history",
        ses_current: "Renamed arbitrarily",
        ses_unattributed: "Dots · unattributed",
        ses_ordinary: "Plain ordinary",
        ses_same_title: "Dots · unattributed",
      }
      for (const [id, title] of Object.entries(titles))
        yield* db.run(sql`INSERT INTO session (id, project_id, directory, title, time_created, time_updated) VALUES (${id}, 'global', '/project', ${title}, 1, 2)`)
      yield* db.run(sql`INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES ('msg_historical', 'ses_historical', 'user', 1, 1, 1, '{"content":[]}')`)
      yield* db.run(sql`INSERT INTO event_sequence (aggregate_id, seq) VALUES ('ses_historical', 1)`)
      yield* db.run(sql`INSERT INTO event (id, aggregate_id, seq, created, type, data) VALUES ('evt_historical', 'ses_historical', 1, 1, 'session.created.1', '{"sessionID":"ses_historical"}')`)

      const thread = "dots.cca.thread.environment.thread-a"
      yield* db.insert(KVTable).values({ key: thread, value: { sessionID: "ses_historical" } }).run()
      yield* db.insert(KVTable).values({ key: "dots.cca.unattributed.environment", value: { sessionID: "ses_unattributed" } }).run()
      yield* db.insert(KVTable).values({ key: thread, value: { sessionID: "ses_current", projectID: "prj_synthetic" } })
        .onConflictDoUpdate({ target: KVTable.key, set: { value: { sessionID: "ses_current", projectID: "prj_synthetic" } } }).run()

      const sessions = yield* db.all(sql`SELECT id, project_id, directory, title, time_created, time_updated FROM session ORDER BY id`)
      const messages = yield* db.all(sql`SELECT * FROM session_message ORDER BY id`)
      const events = yield* db.all(sql`SELECT * FROM event ORDER BY id`)
      const sequences = yield* db.all(sql`SELECT * FROM event_sequence ORDER BY aggregate_id`)
      const completed = yield* db.all(sql`SELECT id FROM migration ORDER BY id`)

      yield* DatabaseMigration.apply(db)
      yield* DatabaseMigration.apply(db)

      const rows = yield* db.select().from(SessionTable).orderBy(SessionTable.id).all()
      const id = SessionSchema.ID.make
      expect(rows.map((row) => [row.id, fromRow(row).origin])).toEqual([
        [id("ses_current"), "dots-executor"],
        [id("ses_historical"), undefined],
        [id("ses_ordinary"), undefined],
        [id("ses_same_title"), undefined],
        [id("ses_unattributed"), "dots-executor"],
      ])
      expect(rows.map((row) => [row.id, row.origin])).toEqual([
        [id("ses_current"), "dots-executor"],
        [id("ses_historical"), null],
        [id("ses_ordinary"), null],
        [id("ses_same_title"), null],
        [id("ses_unattributed"), "dots-executor"],
      ])
      expect(yield* db.all(sql`SELECT id, project_id, directory, title, time_created, time_updated FROM session ORDER BY id`)).toEqual(sessions)
      expect(yield* db.all(sql`SELECT * FROM session_message ORDER BY id`)).toEqual(messages)
      expect(yield* db.all(sql`SELECT * FROM event ORDER BY id`)).toEqual(events)
      expect(yield* db.all(sql`SELECT * FROM event_sequence ORDER BY aggregate_id`)).toEqual(sequences)
      expect(yield* db.all(sql`SELECT id FROM migration WHERE id NOT LIKE '%_session-origin' ORDER BY id`)).toEqual(completed)
      expect(yield* db.all(sql`SELECT id FROM migration WHERE id LIKE '%_session-origin'`)).toHaveLength(1)
      expect(yield* db.all(sql`PRAGMA foreign_key_check`)).toEqual([])
    }),
  )
})

test("the origin migration leaves an empty registry untouched and is applied once", async () => {
  await run(
    Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      yield* db.run(sql.raw("CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT NOT NULL)"))
      yield* db.run(sql.raw("CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)"))
      yield* db.run(sql`INSERT INTO session (id, title) VALUES ('ses_ordinary', 'Ordinary')`)
      yield* DatabaseMigration.applyOnly(db, [migration!])
      yield* DatabaseMigration.applyOnly(db, [migration!])
      expect(yield* db.all(sql`SELECT id, origin FROM session`)).toEqual([{ id: "ses_ordinary", origin: null }])
      expect(yield* db.all(sql`SELECT id FROM migration WHERE id = ${migration!.id}`)).toHaveLength(1)
    }),
  )
})
