import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { applyMigration, migratedDatabase } from "./support/d1-sqlite"

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

const deployedUpsert = "INSERT INTO push_subscription (endpoint, account_id, p256dh, auth, created_at, agent_completed, approval_requested, machine_offline) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET account_id = excluded.account_id, p256dh = excluded.p256dh, auth = excluded.auth, created_at = excluded.created_at, failures = 0, agent_completed = excluded.agent_completed, approval_requested = excluded.approval_requested, machine_offline = excluded.machine_offline"
const deployedRenewal = "INSERT INTO push_subscription (endpoint, account_id, p256dh, auth, created_at, agent_completed, approval_requested, machine_offline) SELECT ?, account_id, ?, ?, ?, agent_completed, approval_requested, machine_offline FROM push_subscription WHERE account_id = ? AND endpoint = ? ON CONFLICT(endpoint) DO UPDATE SET account_id = excluded.account_id, p256dh = excluded.p256dh, auth = excluded.auth, created_at = excluded.created_at, failures = 0, agent_completed = excluded.agent_completed, approval_requested = excluded.approval_requested, machine_offline = excluded.machine_offline"

test("the browser-owner migration clears only push registrations, and the v0.7.16 worker's writes cannot create a registration without a browser owner", async () => {
  const db = await migratedDatabase("0004_push_categories.sql")
  try {
    db.prepare('INSERT INTO "user" (id, created_at) VALUES (?, ?)').run("usr_1", 1)
    db.prepare("INSERT INTO browser_session (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run("bs_1", "usr_1", 1, 10_000)
    db.prepare("INSERT INTO device (id, user_id, name, public_key_jwk, key_algorithm, created_at) VALUES (?, ?, ?, ?, ?, ?)").run("dev_1", "usr_1", "Mac", "{}", "ES256", 1)
    db.prepare("INSERT INTO device_credential (id, device_id, kind, created_at, expires_at) VALUES (?, ?, ?, ?, ?)").run("cred_1", "dev_1", "access", 1, 10_000)
    db.prepare("INSERT INTO invite (id, token_hash, created_at) VALUES (?, ?, ?)").run("inv_1", "hash", 1)
    for (const endpoint of ["https://fcm.googleapis.com/fcm/send/a", "https://web.push.apple.com/b"])
      db.prepare("INSERT INTO push_subscription (endpoint, account_id, p256dh, auth, created_at, agent_completed) VALUES (?, ?, ?, ?, ?, ?)").run(endpoint, "usr_1", "public", "secret", 2, 0)
    const tables = () => Object.fromEntries(["user", "browser_session", "device", "device_credential", "invite", "identity", "enrollment", "device_challenge", "oauth_transaction"]
      .map((table) => [table, db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all()]))
    const before = tables()
    await applyMigration(db, "0005_push_browser_owner.sql")
    expect(tables()).toEqual(before)
    expect(db.prepare("SELECT COUNT(*) AS count FROM push_subscription").get()).toEqual({ count: 0 })
    expect(db.prepare("PRAGMA table_info('push_subscription')").all()).toContainEqual(expect.objectContaining({ name: "browser_session_id", notnull: 1, dflt_value: null }))
    expect(db.prepare("PRAGMA index_list('push_subscription')").all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "push_subscription_account_idx" }), expect.objectContaining({ name: "push_subscription_browser_session_idx", unique: 1 })]))

    expect(() => db.prepare(deployedUpsert).run("https://fcm.googleapis.com/fcm/send/a", "usr_1", "public", "secret", 3, 1, 1, 1)).toThrow(/NOT NULL/)
    db.prepare("INSERT INTO push_subscription (endpoint, account_id, browser_session_id, p256dh, auth, created_at, machine_offline) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("https://fcm.googleapis.com/fcm/send/owned", "usr_1", "bs_1", "public", "secret", 4, 0)
    expect(() => db.prepare(deployedRenewal).run("https://fcm.googleapis.com/fcm/send/renewed", "public-2", "secret-2", 5, "usr_1", "https://fcm.googleapis.com/fcm/send/owned")).toThrow(/NOT NULL/)
    expect(() => db.prepare(deployedUpsert).run("https://fcm.googleapis.com/fcm/send/owned", "usr_1", "public-3", "secret-3", 6, 1, 1, 1)).toThrow(/NOT NULL/)
    expect(db.prepare("SELECT endpoint, browser_session_id, p256dh, machine_offline FROM push_subscription").all()).toEqual([
      { endpoint: "https://fcm.googleapis.com/fcm/send/owned", browser_session_id: "bs_1", p256dh: "public", machine_offline: 0 }])
    expect(() => db.prepare("UPDATE push_subscription SET agent_completed = 2").run()).toThrow()
    db.prepare('DELETE FROM "user" WHERE id = ?').run("usr_1")
    expect(db.prepare("SELECT COUNT(*) AS count FROM push_subscription").get()).toEqual({ count: 0 })
  } finally { db.close() }
})
