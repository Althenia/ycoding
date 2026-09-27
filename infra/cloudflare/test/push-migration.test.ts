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
