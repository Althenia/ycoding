import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { createD1PushStore } from "../src/push/d1-store"

function databasePort(sqlite: Database): D1Database {
  const value: unknown = {
    prepare: (sql: string) => ({ bind: (...values: (string | number)[]) => ({
      run: async () => sqlite.prepare(sql).run(...values),
      all: async () => ({ results: sqlite.prepare(sql).all(...values) }),
    }) }),
    batch: async (statements: readonly { run: () => Promise<unknown> }[]) => {
      sqlite.exec("BEGIN")
      try {
        const results = []
        for (const statement of statements) results.push(await statement.run())
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

test("D1 push store evicts the oldest of eleven, scopes account removal, and settles consecutive failures", async () => {
  const sqlite = new Database(":memory:")
  try {
    sqlite.exec("PRAGMA foreign_keys = ON")
    sqlite.exec(await Bun.file(new URL("../migrations/0001_auth.sql", import.meta.url)).text())
    sqlite.exec(await Bun.file(new URL("../migrations/0002_push.sql", import.meta.url)).text())
    sqlite.prepare('INSERT INTO "user" (id, created_at) VALUES (?, ?)').run("usr_1", 1)
    sqlite.prepare('INSERT INTO "user" (id, created_at) VALUES (?, ?)').run("usr_2", 1)
    const store = createD1PushStore(databasePort(sqlite))
    for (let index = 0; index < 11; index += 1)
      await store.upsert("usr_1", { endpoint: `https://fcm.googleapis.com/send/${index}`,
        keys: { p256dh: `public-${index}`, auth: "auth" } }, index)
    expect((await store.list("usr_1")).map((row) => row.endpoint)).not.toContain("https://fcm.googleapis.com/send/0")
    expect(await store.list("usr_1")).toHaveLength(10)
    const endpoint = "https://fcm.googleapis.com/send/10"
    await store.remove("usr_2", endpoint)
    expect(await store.list("usr_1")).toHaveLength(10)
    await store.upsert("usr_2", { endpoint, keys: { p256dh: "replacement", auth: "auth" } }, 20)
    expect(await store.list("usr_1")).toHaveLength(9)
    const old = (await store.list("usr_2"))[0]
    if (!old) throw new Error("subscription not retained")
    for (let index = 0; index < 4; index += 1) await store.recordFailure(old, false)
    expect((await store.list("usr_2"))[0]?.failures).toBe(4)
    await store.recordFailure(old, false)
    expect(await store.list("usr_2")).toEqual([])
    await store.upsert("usr_2", { endpoint, keys: { p256dh: "fresh", auth: "auth" } }, 21)
    await store.recordFailure(old, true)
    expect(await store.list("usr_2")).toHaveLength(1)
  } finally { sqlite.close() }
})
