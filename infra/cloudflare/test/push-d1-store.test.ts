import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { createD1PushStore } from "../src/push/d1-store"

function databasePort(sqlite: Database): D1Database {
  const value: unknown = {
    prepare: (sql: string) => ({ bind: (...values: (string | number)[]) => ({
      run: async () => ({ results: [], meta: { changes: sqlite.prepare(sql).run(...values).changes } }),
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

const allOn = { "agent-completed": true, "approval-requested": true, "machine-offline": true }

async function migrate(sqlite: Database) {
  sqlite.exec("PRAGMA foreign_keys = ON")
  for (const name of ["0001_auth.sql", "0002_push.sql", "0003_invite.sql", "0004_push_categories.sql"])
    sqlite.exec(await Bun.file(new URL(`../migrations/${name}`, import.meta.url)).text())
  sqlite.prepare('INSERT INTO "user" (id, created_at) VALUES (?, ?)').run("usr_1", 1)
  sqlite.prepare('INSERT INTO "user" (id, created_at) VALUES (?, ?)').run("usr_2", 1)
}

function isD1Database(value: unknown): value is D1Database {
  return typeof value === "object" && value !== null && typeof Reflect.get(value, "prepare") === "function" &&
    typeof Reflect.get(value, "batch") === "function"
}

test("D1 push store evicts the oldest of eleven, scopes account removal, and settles consecutive failures", async () => {
  const sqlite = new Database(":memory:")
  try {
    await migrate(sqlite)
    const store = createD1PushStore(databasePort(sqlite))
    for (let index = 0; index < 11; index += 1)
      await store.upsert("usr_1", { endpoint: `https://fcm.googleapis.com/send/${index}`,
        keys: { p256dh: `public-${index}`, auth: "auth" }, categories: allOn }, index)
    expect((await store.list("usr_1")).map((row) => row.endpoint)).not.toContain("https://fcm.googleapis.com/send/0")
    expect(await store.list("usr_1")).toHaveLength(10)
    const endpoint = "https://fcm.googleapis.com/send/10"
    await store.remove("usr_2", endpoint)
    expect(await store.list("usr_1")).toHaveLength(10)
    await store.upsert("usr_2", { endpoint, keys: { p256dh: "replacement", auth: "auth" }, categories: allOn }, 20)
    expect(await store.list("usr_1")).toHaveLength(9)
    const old = (await store.list("usr_2"))[0]
    if (!old) throw new Error("subscription not retained")
    for (let index = 0; index < 4; index += 1) await store.recordFailure(old, false)
    expect((await store.list("usr_2"))[0]?.failures).toBe(4)
    await store.recordFailure(old, false)
    expect(await store.list("usr_2")).toEqual([])
    await store.upsert("usr_2", { endpoint, keys: { p256dh: "fresh", auth: "auth" }, categories: allOn }, 21)
    await store.recordFailure(old, true)
    expect(await store.list("usr_2")).toHaveLength(1)
  } finally { sqlite.close() }
})


test("D1 push store keeps each subscription's own System categories across re-registration and renewal", async () => {
  const sqlite = new Database(":memory:")
  try {
    await migrate(sqlite)
    const store = createD1PushStore(databasePort(sqlite))
    const iphone = "https://web.push.apple.com/iphone"
    const mac = "https://fcm.googleapis.com/send/mac"
    const quiet = { "agent-completed": false, "approval-requested": true, "machine-offline": false }
    await store.upsert("usr_1", { endpoint: iphone, keys: { p256dh: "phone", auth: "auth" }, categories: quiet }, 1)
    await store.upsert("usr_1", { endpoint: mac, keys: { p256dh: "mac", auth: "auth" }, categories: allOn }, 2)
    expect((await store.list("usr_1")).map((row) => [row.endpoint, row.categories])).toEqual([[mac, allOn], [iphone, quiet]])
    await store.upsert("usr_1", { endpoint: mac, keys: { p256dh: "mac", auth: "auth" }, categories: { ...allOn, "machine-offline": false } }, 3)
    expect((await store.list("usr_1")).find((row) => row.endpoint === mac)?.categories).toEqual({ ...allOn, "machine-offline": false })

    const renewed = "https://web.push.apple.com/iphone-renewed"
    expect(await store.renew("usr_2", { endpoint: renewed, keys: { p256dh: "other", auth: "auth" }, replaces: iphone }, 4)).toBe(false)
    expect(await store.renew("usr_1", { endpoint: renewed, keys: { p256dh: "phone-2", auth: "auth" }, replaces: iphone }, 5)).toBe(true)
    const rows = await store.list("usr_1")
    expect(rows.map((row) => row.endpoint)).toEqual([renewed, mac])
    expect(rows[0]).toMatchObject({ keys: { p256dh: "phone-2", auth: "auth" }, categories: quiet, failures: 0 })
    expect(await store.renew("usr_1", { endpoint: "https://web.push.apple.com/lost", keys: { p256dh: "x", auth: "auth" }, replaces: iphone }, 6)).toBe(false)
    expect((await store.list("usr_1")).map((row) => row.endpoint)).toEqual([renewed, mac])
    expect(await store.list("usr_2")).toEqual([])
  } finally { sqlite.close() }
})

test("D1 push store claims one test alert per subscription per window and never another account's subscription", async () => {
  const sqlite = new Database(":memory:")
  try {
    await migrate(sqlite)
    const store = createD1PushStore(databasePort(sqlite))
    const endpoint = "https://fcm.googleapis.com/send/windows"
    await store.upsert("usr_1", { endpoint, keys: { p256dh: "win", auth: "auth" }, categories: allOn }, 1)
    expect(await store.claimTest("usr_2", endpoint, 1_000)).toEqual({ status: "missing" })
    expect(await store.claimTest("usr_1", endpoint, 1_000)).toMatchObject({ status: "claimed", subscription: { endpoint, accountID: "usr_1", keys: { p256dh: "win", auth: "auth" } } })
    expect(await store.claimTest("usr_1", endpoint, 60_999)).toEqual({ status: "limited" })
    expect(await store.claimTest("usr_1", endpoint, 61_000)).toMatchObject({ status: "claimed" })
  } finally { sqlite.close() }
})
