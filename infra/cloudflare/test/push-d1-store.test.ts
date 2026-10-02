import { expect, test } from "bun:test"
import { createD1AuthStore } from "../src/auth/d1-store"
import { createD1PushStore } from "../src/push/d1-store"
import { migratedDatabase, sqliteD1 } from "./support/d1-sqlite"

const allOn = { "agent-completed": true, "approval-requested": true, "machine-offline": true }

async function migrate() {
  const sqlite = await migratedDatabase()
  sqlite.prepare('INSERT INTO "user" (id, created_at) VALUES (?, ?)').run("usr_1", 1)
  sqlite.prepare('INSERT INTO "user" (id, created_at) VALUES (?, ?)').run("usr_2", 1)
  for (const id of [...Array.from({ length: 11 }, (_, index) => `bs_${index}`), "bs_usr_1", "bs_iphone", "bs_mac", "bs_laptop", "bs_phone"])
    sqlite.prepare("INSERT INTO browser_session (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(id, "usr_1", 1, 10_000)
  sqlite.prepare("INSERT INTO browser_session (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run("bs_usr_2", "usr_2", 1, 10_000)
  return sqlite
}

test("D1 push store evicts the oldest of eleven, scopes account removal, and settles consecutive failures", async () => {
  const sqlite = await migrate()
  try {
    const store = createD1PushStore(sqliteD1(sqlite))
    for (let index = 0; index < 11; index += 1)
      await store.upsert("usr_1", `bs_${index}`, { endpoint: `https://fcm.googleapis.com/send/${index}`,
        keys: { p256dh: `public-${index}`, auth: "auth" }, categories: allOn }, index)
    expect((await store.list("usr_1")).map((row) => row.endpoint)).not.toContain("https://fcm.googleapis.com/send/0")
    expect(await store.list("usr_1")).toHaveLength(10)
    const endpoint = "https://fcm.googleapis.com/send/10"
    await store.remove("usr_2", endpoint)
    expect(await store.list("usr_1")).toHaveLength(10)
    await store.upsert("usr_2", "bs_usr_2", { endpoint, keys: { p256dh: "replacement", auth: "auth" }, categories: allOn }, 20)
    expect(await store.list("usr_1")).toHaveLength(9)
    const old = (await store.list("usr_2"))[0]
    if (!old) throw new Error("subscription not retained")
    for (let index = 0; index < 4; index += 1) await store.recordFailure(old, false)
    expect((await store.list("usr_2"))[0]?.failures).toBe(4)
    await store.recordSuccess(old)
    expect((await store.list("usr_2"))[0]?.failures).toBe(0)
    for (let index = 0; index < 4; index += 1) await store.recordFailure(old, false)
    expect(await store.list("usr_2")).toHaveLength(1)
    await store.recordFailure(old, false)
    expect(await store.list("usr_2")).toEqual([])
    await store.upsert("usr_2", "bs_usr_2", { endpoint, keys: { p256dh: "fresh", auth: "auth" }, categories: allOn }, 21)
    await store.recordFailure(old, true)
    expect(await store.list("usr_2")).toHaveLength(1)
  } finally { sqlite.close() }
})


test("D1 push store keeps each subscription's own System categories across re-registration and renewal", async () => {
  const sqlite = await migrate()
  try {
    const store = createD1PushStore(sqliteD1(sqlite))
    const iphone = "https://web.push.apple.com/iphone"
    const mac = "https://fcm.googleapis.com/send/mac"
    const quiet = { "agent-completed": false, "approval-requested": true, "machine-offline": false }
    await store.upsert("usr_1", "bs_iphone", { endpoint: iphone, keys: { p256dh: "phone", auth: "auth" }, categories: quiet }, 1)
    await store.upsert("usr_1", "bs_mac", { endpoint: mac, keys: { p256dh: "mac", auth: "auth" }, categories: allOn }, 2)
    expect((await store.list("usr_1")).map((row) => [row.endpoint, row.categories])).toEqual([[mac, allOn], [iphone, quiet]])
    await store.upsert("usr_1", "bs_mac", { endpoint: mac, keys: { p256dh: "mac", auth: "auth" }, categories: { ...allOn, "machine-offline": false } }, 3)
    expect((await store.list("usr_1")).find((row) => row.endpoint === mac)?.categories).toEqual({ ...allOn, "machine-offline": false })

    const renewed = "https://web.push.apple.com/iphone-renewed"
    expect(await store.renew("usr_2", "bs_usr_2", { endpoint: renewed, keys: { p256dh: "other", auth: "auth" }, replaces: iphone }, 4)).toBe("missing")
    expect(await store.renew("usr_1", "bs_iphone", { endpoint: renewed, keys: { p256dh: "phone-2", auth: "auth" }, replaces: iphone }, 5)).toBe("written")
    const rows = await store.list("usr_1")
    expect(rows.map((row) => row.endpoint)).toEqual([renewed, mac])
    expect(rows[0]).toMatchObject({ keys: { p256dh: "phone-2", auth: "auth" }, categories: quiet, failures: 0 })
    expect(await store.renew("usr_1", "bs_iphone", { endpoint: "https://web.push.apple.com/lost", keys: { p256dh: "x", auth: "auth" }, replaces: iphone }, 6)).toBe("missing")
    expect((await store.list("usr_1")).map((row) => row.endpoint)).toEqual([renewed, mac])
    expect(await store.list("usr_2")).toEqual([])
  } finally { sqlite.close() }
})

test("D1 push store claims one test alert per subscription per window and never another account's subscription", async () => {
  const sqlite = await migrate()
  try {
    const store = createD1PushStore(sqliteD1(sqlite))
    const endpoint = "https://fcm.googleapis.com/send/windows"
    await store.upsert("usr_1", "bs_usr_1", { endpoint, keys: { p256dh: "win", auth: "auth" }, categories: allOn }, 1)
    expect(await store.claimTest("usr_2", endpoint, 1_000)).toEqual({ status: "missing" })
    expect(await store.claimTest("usr_1", endpoint, 1_000)).toMatchObject({ status: "claimed", subscription: { endpoint, accountID: "usr_1", keys: { p256dh: "win", auth: "auth" } } })
    expect(await store.claimTest("usr_1", endpoint, 60_999)).toEqual({ status: "limited" })
    expect(await store.claimTest("usr_1", endpoint, 61_000)).toMatchObject({ status: "claimed" })
  } finally { sqlite.close() }
})

test("each registration and renewal is owned by the verified browser session that wrote it, and a rotated session keeps its browser's registrations", async () => {
  const sqlite = await migrate()
  try {
    const db = sqliteD1(sqlite)
    const store = createD1PushStore(db)
    const auth = createD1AuthStore(db)
    const laptop = "https://fcm.googleapis.com/send/laptop"
    const phone = "https://web.push.apple.com/phone"
    await store.upsert("usr_1", "bs_laptop", { endpoint: laptop, keys: { p256dh: "laptop", auth: "auth" }, categories: allOn }, 1)
    await store.upsert("usr_1", "bs_phone", { endpoint: phone, keys: { p256dh: "phone", auth: "auth" }, categories: allOn }, 2)
    expect((await store.list("usr_1")).map((row) => [row.endpoint, row.browserSessionID])).toEqual([[phone, "bs_phone"], [laptop, "bs_laptop"]])

    const renewed = "https://fcm.googleapis.com/send/laptop-renewed"
    expect(await store.renew("usr_1", "bs_laptop", { endpoint: renewed, keys: { p256dh: "laptop-2", auth: "auth" }, replaces: laptop }, 3)).toBe("written")
    expect((await store.list("usr_1")).map((row) => [row.endpoint, row.browserSessionID])).toEqual([[renewed, "bs_laptop"], [phone, "bs_phone"]])

    expect(await auth.rotateBrowserSession("bs_laptop", { id: "bs_laptop_2", userID: "usr_1", createdAt: 4, expiresAt: 20_000 }, 4)).toBe(true)
    expect((await store.list("usr_1")).map((row) => [row.endpoint, row.browserSessionID])).toEqual([[renewed, "bs_laptop_2"], [phone, "bs_phone"]])
    expect(await auth.rotateBrowserSession("bs_laptop", { id: "bs_laptop_3", userID: "usr_1", createdAt: 5, expiresAt: 20_000 }, 5)).toBe(false)
    expect((await store.list("usr_1")).map((row) => [row.endpoint, row.browserSessionID])).toEqual([[renewed, "bs_laptop_2"], [phone, "bs_phone"]])

    await store.upsert("usr_1", "bs_phone", { endpoint: renewed, keys: { p256dh: "laptop-2", auth: "auth" }, categories: allOn }, 6)
    expect((await store.list("usr_1")).find((row) => row.endpoint === renewed)?.browserSessionID).toBe("bs_phone")
  } finally { sqlite.close() }
})

test("each verified browser keeps exactly one current registration: a new endpoint replaces its previous one, and a renewal replaces it in place with its categories", async () => {
  const sqlite = await migrate()
  try {
    const store = createD1PushStore(sqliteD1(sqlite))
    const quiet = { "agent-completed": false, "approval-requested": true, "machine-offline": false }
    const endpoint = (name: string) => `https://fcm.googleapis.com/send/${name}`
    const owners = async () => (await store.list("usr_1")).map((row) => [row.endpoint, row.browserSessionID, row.categories])
    await store.upsert("usr_1", "bs_laptop", { endpoint: endpoint("old"), keys: { p256dh: "old", auth: "auth" }, categories: quiet }, 1)
    await store.upsert("usr_1", "bs_phone", { endpoint: endpoint("phone"), keys: { p256dh: "phone", auth: "auth" }, categories: allOn }, 2)
    await store.upsert("usr_1", "bs_laptop", { endpoint: endpoint("new"), keys: { p256dh: "new", auth: "auth" }, categories: allOn }, 3)
    expect(await owners()).toEqual([[endpoint("new"), "bs_laptop", allOn], [endpoint("phone"), "bs_phone", allOn]])

    await store.upsert("usr_1", "bs_laptop", { endpoint: endpoint("phone"), keys: { p256dh: "phone", auth: "auth" }, categories: quiet }, 4)
    expect(await owners()).toEqual([[endpoint("phone"), "bs_laptop", quiet]])

    await store.upsert("usr_1", "bs_phone", { endpoint: endpoint("phone-2"), keys: { p256dh: "phone-2", auth: "auth" }, categories: allOn }, 5)
    expect(await store.renew("usr_1", "bs_phone", { endpoint: endpoint("renewed"), keys: { p256dh: "renewed", auth: "auth" }, replaces: endpoint("phone") }, 6)).toBe("written")
    expect(await owners()).toEqual([[endpoint("renewed"), "bs_phone", quiet]])
    expect(await store.renew("usr_1", "bs_phone", { endpoint: endpoint("lost"), keys: { p256dh: "lost", auth: "auth" }, replaces: endpoint("missing") }, 7)).toBe("missing")
    expect(await owners()).toEqual([[endpoint("renewed"), "bs_phone", quiet]])

    expect(() => sqlite.prepare("INSERT INTO push_subscription (endpoint, account_id, browser_session_id, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(endpoint("second"), "usr_1", "bs_phone", "x", "auth", 8)).toThrow(/UNIQUE/)
  } finally { sqlite.close() }
})

for (const refusal of ["revoked", "expired", "wrong-account", "unknown"] as const) {
  test(`D1 push writes reject a ${refusal} session without deleting or transferring either endpoint`, async () => {
    const sqlite = await migrate()
    try {
      const store = createD1PushStore(sqliteD1(sqlite))
      const current = "https://fcm.googleapis.com/send/current"
      const target = "https://web.push.apple.com/target"
      const keys = { p256dh: "public", auth: "auth" }
      expect(await store.upsert("usr_1", "bs_laptop", { endpoint: current, keys, categories: allOn }, 1)).toBe(true)
      expect(await store.upsert("usr_2", "bs_usr_2", { endpoint: target, keys, categories: allOn }, 2)).toBe(true)
      if (refusal === "revoked") sqlite.prepare("UPDATE browser_session SET revoked_at = 3 WHERE id = ?").run("bs_laptop")
      if (refusal === "expired") sqlite.prepare("UPDATE browser_session SET expires_at = 3 WHERE id = ?").run("bs_laptop")
      const sessionID = refusal === "unknown" ? "bs_missing" : "bs_laptop"
      const accountID = refusal === "wrong-account" ? "usr_2" : "usr_1"
      const before = [...await store.list("usr_1"), ...await store.list("usr_2")]
      expect(await store.upsert(accountID, sessionID, { endpoint: target, keys, categories: { ...allOn, "machine-offline": false } }, 3)).toBe(false)
      expect(await store.renew(accountID, sessionID, { endpoint: target, keys, replaces: current }, 3)).toBe("unauthorized")
      expect([...await store.list("usr_1"), ...await store.list("usr_2")]).toEqual(before)
    } finally { sqlite.close() }
  })
}

test("D1 push database failures remain observable and roll back preceding endpoint removal", async () => {
  const sqlite = await migrate()
  try {
    const store = createD1PushStore(sqliteD1(sqlite))
    const endpoint = "https://fcm.googleapis.com/send/current"
    const keys = { p256dh: "public", auth: "auth" }
    await store.upsert("usr_1", "bs_laptop", { endpoint, keys, categories: allOn }, 1)
    const before = await store.list("usr_1")
    sqlite.exec("CREATE TRIGGER reject_push_insert BEFORE INSERT ON push_subscription BEGIN SELECT RAISE(ABORT, 'push write failure'); END")
    await expect(store.upsert("usr_1", "bs_laptop", { endpoint: "https://fcm.googleapis.com/send/new", keys, categories: allOn }, 2)).rejects.toThrow("push write failure")
    expect(await store.list("usr_1")).toEqual(before)
    sqlite.exec("CREATE TRIGGER reject_push_update BEFORE UPDATE ON push_subscription BEGIN SELECT RAISE(ABORT, 'push renewal failure'); END")
    await expect(store.renew("usr_1", "bs_laptop", { endpoint: "https://fcm.googleapis.com/send/renewed", keys, replaces: endpoint }, 2)).rejects.toThrow("push renewal failure")
    expect(await store.list("usr_1")).toEqual(before)
  } finally { sqlite.close() }
})
