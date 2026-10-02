import { expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@ycoding-ai/effect-drizzle-sqlite"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { DatabaseMigration } from "@ycoding-ai/core/database/migration"
import dropLegacy from "../src/database/migration/20261002020321_drop-legacy-account-share"

test("drops the legacy account and share tables and keeps sessions", async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const db = yield* EffectDrizzleSqlite.makeWithDefaults()
    yield* db.run(sql.raw("PRAGMA foreign_keys = ON"))
    yield* db.run(sql.raw("CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT NOT NULL)"))
    yield* db.run(sql.raw("CREATE TABLE account (id TEXT PRIMARY KEY, email TEXT NOT NULL)"))
    yield* db.run(sql.raw("CREATE TABLE account_state (id INTEGER PRIMARY KEY, active_account_id TEXT REFERENCES account(id) ON DELETE SET NULL)"))
    yield* db.run(sql.raw("CREATE TABLE control_account (email TEXT NOT NULL, url TEXT NOT NULL, PRIMARY KEY (email, url))"))
    yield* db.run(sql.raw("CREATE TABLE session_share (session_id TEXT PRIMARY KEY REFERENCES session(id) ON DELETE CASCADE, url TEXT NOT NULL)"))
    yield* db.run(sql.raw("INSERT INTO session VALUES ('ses_1', 'kept')"))
    yield* db.run(sql.raw("INSERT INTO account VALUES ('acc_1', 'a@example.com')"))
    yield* db.run(sql.raw("INSERT INTO account_state VALUES (1, 'acc_1')"))
    yield* db.run(sql.raw("INSERT INTO control_account VALUES ('a@example.com', 'https://example.com')"))
    yield* db.run(sql.raw("INSERT INTO session_share VALUES ('ses_1', 'https://example.com/s')"))
    yield* DatabaseMigration.applyOnly(db, [dropLegacy])
    expect(
      yield* db.all(sql`SELECT name FROM sqlite_master WHERE name IN ('account', 'account_state', 'control_account', 'session_share')`),
    ).toEqual([])
    expect(yield* db.all(sql`SELECT id, title FROM session`)).toEqual([{ id: "ses_1", title: "kept" }])
  }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped))
})
