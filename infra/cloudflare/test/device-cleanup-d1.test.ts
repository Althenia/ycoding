import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { createD1AuthStore } from "../src/auth/d1-store"

function databasePort(sqlite: Database): D1Database {
  const value: unknown = {
    prepare: (sql: string) => ({ bind: (...values: (string | number | null)[]) => ({
      run: async () => ({ meta: { changes: sqlite.prepare(sql).run(...values).changes } }),
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

test("D1 cleanup removes only owned revoked devices and their dependent metadata without a migration", async () => {
  const sqlite = new Database(":memory:")
  try {
    sqlite.exec("PRAGMA foreign_keys = ON")
    sqlite.exec(await Bun.file(new URL("../migrations/0001_auth.sql", import.meta.url)).text())
    for (const user of ["owner", "other"]) sqlite.prepare('INSERT INTO "user" (id, created_at) VALUES (?, 1)').run(user)
    for (const [id, userID, revoked] of [["old1", "owner", 1], ["old2", "owner", 2], ["active", "owner", null], ["foreign", "other", 3]] as const) {
      sqlite.prepare("INSERT INTO device (id, user_id, name, public_key_jwk, key_algorithm, created_at, revoked_at) VALUES (?, ?, ?, ?, 'P-256', 1, ?)")
        .run(id, userID, id, "{}", revoked)
      sqlite.prepare("INSERT INTO device_credential (id, device_id, kind, created_at, expires_at) VALUES (?, ?, 'access', 1, 100)").run(`cred_${id}`, id)
      sqlite.prepare("INSERT INTO device_challenge (id, device_id, nonce, created_at, expires_at) VALUES (?, ?, 'nonce', 1, 100)").run(`chl_${id}`, id)
      sqlite.prepare("INSERT INTO enrollment (id, code_hash, user_id, created_at, expires_at, device_id) VALUES (?, ?, ?, 1, 100, ?)").run(`enr_${id}`, id, userID, id)
    }
    const store = createD1AuthStore(databasePort(sqlite))
    await store.deleteRevokedDevices("owner", "active")
    await store.deleteRevokedDevices("owner", "foreign")
    expect(sqlite.prepare("SELECT id FROM device ORDER BY id").all().map((row) => row.id)).toEqual(["active", "foreign", "old1", "old2"])
    await store.deleteRevokedDevices("owner", "old1")
    await store.deleteRevokedDevices("owner", "old1")
    expect(sqlite.prepare("SELECT id FROM device ORDER BY id").all().map((row) => row.id)).toEqual(["active", "foreign", "old2"])
    await store.deleteRevokedDevices("owner")
    await store.deleteRevokedDevices("owner")
    for (const table of ["device", "device_credential", "device_challenge", "enrollment"]) {
      const field = table === "device" ? "id" : "device_id"
      expect(sqlite.prepare(`SELECT ${field} AS device FROM ${table} ORDER BY 1`).all().map((row) => row.device)).toEqual(["active", "foreign"])
    }
  } finally { sqlite.close() }
})
