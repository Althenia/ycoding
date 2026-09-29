import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"

test("push subscription migration applies after auth and cascades account deletion", async () => {
  const db = new Database(":memory:")
  try {
    db.exec("PRAGMA foreign_keys = ON")
    db.exec(await Bun.file(new URL("../migrations/0001_auth.sql", import.meta.url)).text())
    db.exec(await Bun.file(new URL("../migrations/0002_push.sql", import.meta.url)).text())
    db.prepare('INSERT INTO "user" (id, created_at) VALUES (?, ?)').run("usr_1", 1)
    db.prepare("INSERT INTO push_subscription (endpoint, account_id, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)")
      .run("https://fcm.googleapis.com/fcm/send/test", "usr_1", "public", "secret", 2)
    expect(db.prepare("SELECT failures FROM push_subscription").get()).toEqual({ failures: 0 })
    expect(db.prepare("PRAGMA index_list('push_subscription')").all().some((index) =>
      typeof index === "object" && index !== null && Reflect.get(index, "name") === "push_subscription_account_idx")).toBe(true)
    db.prepare('DELETE FROM "user" WHERE id = ?').run("usr_1")
    expect(db.prepare("SELECT COUNT(*) AS count FROM push_subscription").get()).toEqual({ count: 0 })
  } finally { db.close() }
})

test("push category migration keeps every existing subscription with all System categories on and rejects non-boolean choices", async () => {
  const db = new Database(":memory:")
  try {
    db.exec("PRAGMA foreign_keys = ON")
    db.exec(await Bun.file(new URL("../migrations/0001_auth.sql", import.meta.url)).text())
    db.exec(await Bun.file(new URL("../migrations/0002_push.sql", import.meta.url)).text())
    db.exec(await Bun.file(new URL("../migrations/0003_invite.sql", import.meta.url)).text())
    db.prepare('INSERT INTO "user" (id, created_at) VALUES (?, ?)').run("usr_1", 1)
    const insert = db.prepare("INSERT INTO push_subscription (endpoint, account_id, p256dh, auth, created_at, failures) VALUES (?, ?, ?, ?, ?, ?)")
    insert.run("https://fcm.googleapis.com/fcm/send/windows", "usr_1", "public-a", "secret-a", 2, 3)
    insert.run("https://fcm.googleapis.com/fcm/send/mac", "usr_1", "public-b", "secret-b", 3, 0)
    db.exec(await Bun.file(new URL("../migrations/0004_push_categories.sql", import.meta.url)).text())
    expect(db.prepare("SELECT endpoint, account_id, p256dh, auth, created_at, failures, agent_completed, approval_requested, machine_offline, tested_at FROM push_subscription ORDER BY created_at").all()).toEqual([
      { endpoint: "https://fcm.googleapis.com/fcm/send/windows", account_id: "usr_1", p256dh: "public-a", auth: "secret-a", created_at: 2, failures: 3,
        agent_completed: 1, approval_requested: 1, machine_offline: 1, tested_at: null },
      { endpoint: "https://fcm.googleapis.com/fcm/send/mac", account_id: "usr_1", p256dh: "public-b", auth: "secret-b", created_at: 3, failures: 0,
        agent_completed: 1, approval_requested: 1, machine_offline: 1, tested_at: null },
    ])
    for (const column of ["agent_completed", "approval_requested", "machine_offline"])
      expect(() => db.prepare(`UPDATE push_subscription SET ${column} = 2`).run()).toThrow()
  } finally { db.close() }
})
