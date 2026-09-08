export * as DatabaseMigration from "./migration"

import { sql } from "drizzle-orm"
import { Effect, Semaphore } from "effect"
import type { EffectDrizzleSqlite } from "@ycoding-ai/effect-drizzle-sqlite"
import { migrations } from "./migration.gen"
import schema from "./schema"
import { DatabaseFormat } from "./format"

type Database = EffectDrizzleSqlite.EffectSQLiteDatabase
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0]
const lock = Semaphore.makeUnsafe(1)

export type Migration = {
  id: string
  up: (tx: Transaction) => Effect.Effect<void, unknown>
  format?: {
    readonly from: string
    readonly to: string
  }
}

export function apply(db: Database) {
  return lock.withPermit(
    Effect.gen(function* () {
      const tables = yield* db.all<{ name: string }>(
        sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
      )
      if (tables.some((table) => table.name === "database_format")) {
        const format = yield* db.get<{ id: string }>(sql`SELECT id FROM database_format LIMIT 1`)
        if (format?.id === DatabaseFormat.CurrentID) return yield* applyOnly(db, migrations)
        if (format?.id === DatabaseFormat.PreviousID && tables.some((table) => table.name === "migration")) {
          return yield* applyPrevious(db)
        }
        return yield* Effect.fail(DatabaseFormat.unsupported())
      }
      if (tables.length > 0) return yield* Effect.fail(DatabaseFormat.unsupported())

      yield* db.run("PRAGMA auto_vacuum = INCREMENTAL")
      yield* db.transaction((tx) =>
        Effect.gen(function* () {
          yield* schema.up(tx)
          yield* tx.run(
            sql`CREATE TABLE ${sql.identifier("migration")} (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`,
          )
          yield* Effect.forEach(migrations, (migration) =>
            tx.run(
              sql`INSERT INTO ${sql.identifier("migration")} (id, time_completed) VALUES (${migration.id}, ${Date.now()})`,
            ),
          )
          yield* tx.run(sql`CREATE TABLE database_format (id TEXT PRIMARY KEY, time_created INTEGER NOT NULL)`)
          yield* tx.run(
            sql`INSERT INTO database_format (id, time_created) VALUES (${DatabaseFormat.CurrentID}, ${Date.now()})`,
          )
        }),
      )
    }),
  )
}

function applyPrevious(db: Database) {
  return Effect.gen(function* () {
    const registered: Migration[] = migrations
    const index = registered.findIndex(
      (migration) =>
        migration.format?.from === DatabaseFormat.PreviousID && migration.format.to === DatabaseFormat.CurrentID,
    )
    if (index < 0) return yield* Effect.fail(DatabaseFormat.unsupported())

    const completed = new Set((yield* db.all<{ id: string }>(sql`SELECT id FROM migration`)).map((row) => row.id))
    const upgrade = registered[index]!
    if (completed.has(upgrade.id)) return yield* Effect.fail(DatabaseFormat.unsupported())

    // This transaction is the only compatibility path. The caller must keep the
    // local database quiescent because the semaphore cannot coordinate other processes.
    yield* db.transaction((tx) =>
      Effect.gen(function* () {
        const format = yield* tx.get<{ id: string }>(sql`SELECT id FROM database_format LIMIT 1`)
        if (format?.id !== DatabaseFormat.PreviousID) return yield* Effect.fail(DatabaseFormat.unsupported())
        for (const migration of registered.slice(0, index + 1)) {
          if (completed.has(migration.id)) continue
          yield* migration.up(tx)
          yield* tx.run(sql`INSERT INTO migration (id, time_completed) VALUES (${migration.id}, ${Date.now()})`)
        }
        const upgraded = yield* tx.get<{ id: string }>(sql`SELECT id FROM database_format LIMIT 1`)
        if (upgraded?.id !== DatabaseFormat.CurrentID) return yield* Effect.fail(DatabaseFormat.unsupported())
      }),
    )
    yield* applyOnly(db, registered.slice(index + 1))
  })
}

export function applyOnly(db: Database, input: Migration[]) {
  return Effect.gen(function* () {
    yield* db.run(
      sql`CREATE TABLE IF NOT EXISTS ${sql.identifier("migration")} (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`,
    )
    const completed = new Set(
      (yield* db.all<{ id: string }>(sql`SELECT id FROM ${sql.identifier("migration")}`)).map((row) => row.id),
    )

    for (const migration of input) {
      if (completed.has(migration.id)) continue
      yield* db.transaction((tx) =>
        Effect.gen(function* () {
          yield* migration.up(tx)
          yield* tx.run(
            sql`INSERT INTO ${sql.identifier("migration")} (id, time_completed) VALUES (${migration.id}, ${Date.now()})`,
          )
        }),
      )
    }
  })
}
