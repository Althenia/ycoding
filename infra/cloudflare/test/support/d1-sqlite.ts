import { Database } from "bun:sqlite"
import { readdirSync } from "node:fs"

const migrations = new URL("../../migrations/", import.meta.url)

function migrationNames(): readonly string[] {
  return readdirSync(migrations).filter((name) => name.endsWith(".sql")).sort()
}

export async function migratedDatabase(through?: string): Promise<Database> {
  const sqlite = new Database(":memory:")
  sqlite.exec("PRAGMA foreign_keys = ON")
  for (const name of migrationNames().filter((name) => through === undefined || name <= through))
    sqlite.exec(await Bun.file(new URL(name, migrations)).text())
  return sqlite
}

export async function applyMigration(sqlite: Database, name: string) {
  sqlite.exec(await Bun.file(new URL(name, migrations)).text())
}

export function sqliteD1(sqlite: Database): D1Database {
  const statement = (sql: string, values: readonly (string | number | null)[]) => ({
    run: async () => ({ results: [], meta: { changes: sqlite.prepare(sql).run(...values).changes } }),
    all: async () => ({ results: sqlite.prepare(sql).all(...values) }),
    first: async () => sqlite.prepare(sql).get(...values) ?? null,
  })
  const value: unknown = {
    prepare: (sql: string) => ({ ...statement(sql, []), bind: (...values: (string | number | null)[]) => statement(sql, values) }),
    batch: async (statements: readonly { run: () => Promise<unknown> }[]) => {
      sqlite.exec("BEGIN")
      try {
        const results = []
        for (const item of statements) results.push(await item.run())
        sqlite.exec("COMMIT")
        return results
      } catch (cause) {
        sqlite.exec("ROLLBACK")
        throw cause
      }
    },
  }
  if (!isD1Database(value)) throw new Error("SQLite D1 port is incomplete")
  return value
}

function isD1Database(value: unknown): value is D1Database {
  return typeof value === "object" && value !== null && typeof Reflect.get(value, "prepare") === "function" &&
    typeof Reflect.get(value, "batch") === "function"
}
