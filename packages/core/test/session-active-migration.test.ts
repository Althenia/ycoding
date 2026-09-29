import { expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@ycoding-ai/effect-drizzle-sqlite"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { DatabaseMigration } from "@ycoding-ai/core/database/migration"
import sessionActive from "../src/database/migration/20260929044715_session-active"

test("backfills only terminal activity from stored millisecond events", async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const db = yield* EffectDrizzleSqlite.makeWithDefaults()
    yield* db.run(sql.raw("CREATE TABLE session (id TEXT PRIMARY KEY, time_updated INTEGER NOT NULL)"))
    yield* db.run(sql.raw("CREATE TABLE event (aggregate_id TEXT NOT NULL, type TEXT NOT NULL, created INTEGER NOT NULL)"))
    yield* db.run(sql.raw("INSERT INTO session VALUES ('ses_active', 500), ('ses_none', 600), ('ses_failed', 700)"))
    yield* db.run(sql.raw(`INSERT INTO event VALUES
      ('ses_active', 'session.created.1', 100),
      ('ses_active', 'session.step.ended.1', 200),
      ('ses_active', 'session.execution.succeeded.1', 300),
      ('ses_active', 'session.renamed.1', 900),
      ('ses_none', 'session.created.1', 400),
      ('ses_failed', 'session.step.failed.1', 450),
      ('ses_failed', 'session.execution.failed.1', 550),
      ('ses_failed', 'session.execution.interrupted.1', 650)`))
    yield* DatabaseMigration.applyOnly(db, [sessionActive])
    expect(yield* db.all(sql`SELECT id, time_updated, time_active FROM session ORDER BY id`)).toEqual([
      { id: "ses_active", time_updated: 500, time_active: 300 },
      { id: "ses_failed", time_updated: 700, time_active: 650 },
      { id: "ses_none", time_updated: 600, time_active: null },
    ])
  }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped))
})
