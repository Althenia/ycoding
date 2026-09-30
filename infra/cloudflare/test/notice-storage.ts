import type { Database } from "bun:sqlite"
import type { NoticeStorage } from "../src/relay/notice-store"

export function createNoticeStorage(database: Database): NoticeStorage {
  database.exec("CREATE TABLE IF NOT EXISTS fixture_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
  return {
    sql: { exec: (query, ...bindings) => ({ toArray: () => database.prepare(query).all(...(bindings as never[])) }) },
    kv: {
      get: <Value>(key: string): Value | undefined => {
        const row = database.query("SELECT value FROM fixture_kv WHERE key = ?").get(key) as { value: string } | null
        return row === null ? undefined : JSON.parse(row.value) as Value
      },
      put: (key, value) => { database.query("INSERT OR REPLACE INTO fixture_kv VALUES (?, ?)").run(key, JSON.stringify(value)) },
    },
    transactionSync: (operation) => database.transaction(operation)(),
  }
}
