import { expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@ycoding-ai/effect-drizzle-sqlite"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { DatabaseMigration } from "../src/database/migration"
import { migrations } from "../src/database/migration.gen"

test("MCP attention migration adds nullable metadata without changing retained delivery state", async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const db = yield* EffectDrizzleSqlite.makeWithDefaults()
    yield* db.run(sql`CREATE TABLE mcp_event_outbox (seq INTEGER PRIMARY KEY, id TEXT NOT NULL, attempts INTEGER NOT NULL, delivered_at INTEGER, request_id TEXT)`)
    yield* db.run(sql`INSERT INTO mcp_event_outbox VALUES (1, 'evt_retained', 2, NULL, 'per_retained')`)
    const migration = migrations.find((entry) => entry.id.endsWith("_mcp-event-attention"))
    if (!migration) throw new Error("Missing MCP attention migration")
    yield* DatabaseMigration.applyOnly(db, [migration])
    expect(yield* db.all(sql`SELECT seq, id, attempts, delivered_at, request_id, attention FROM mcp_event_outbox`)).toEqual([
      { seq: 1, id: "evt_retained", attempts: 2, delivered_at: null, request_id: "per_retained", attention: null },
    ])
    yield* DatabaseMigration.applyOnly(db, [migration])
    expect(yield* db.all(sql`SELECT id FROM migration WHERE id = ${migration.id}`)).toHaveLength(1)
    expect((yield* db.all<{ name: string }>(sql`PRAGMA table_info(mcp_event_outbox)`)).filter((column) => column.name === "attention")).toHaveLength(1)
  }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped))
})

test("fresh databases include the bounded attention snapshot column", async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const db = yield* EffectDrizzleSqlite.makeWithDefaults()
    yield* DatabaseMigration.apply(db)
    expect((yield* db.all<{ name: string }>(sql`PRAGMA table_info(mcp_event_outbox)`)).filter((column) => column.name === "attention")).toHaveLength(1)
  }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped))
})
