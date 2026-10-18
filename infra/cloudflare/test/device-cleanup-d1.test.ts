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

test("device revocation atomically removes its MCP grants without touching another owner", async () => {
  const sqlite = new Database(":memory:")
  try {
    sqlite.exec("PRAGMA foreign_keys = ON")
    sqlite.exec(await Bun.file(new URL("../migrations/0001_auth.sql", import.meta.url)).text())
    sqlite.exec(await Bun.file(new URL("../migrations/0006_relay_mcp.sql", import.meta.url)).text())
    sqlite.exec(`INSERT INTO "user" (id, created_at) VALUES ('owner', 1), ('other', 1);
      INSERT INTO device (id, user_id, name, public_key_jwk, key_algorithm, created_at)
        VALUES ('device', 'owner', 'Synthetic device', '{}', 'P-256', 1);
      INSERT INTO mcp_device VALUES ('device', 1, 'epoch_test', 1);
      INSERT INTO mcp_client (client_id,kind,name,redirect_uris,auth_method,created_at) VALUES ('client', 'dcr', 'Synthetic client', '[]', 'none', 1);
      INSERT INTO mcp_grant (id,client_id,device_id,owner_id,resource,scope,enable_epoch,consented_at,expires_at)
        VALUES ('grant','client','device','owner','https://relay.example.invalid/api/mcp/devices/device','ycoding:remote','epoch_test',1,100);
      INSERT INTO mcp_token (token_hash,grant_id,kind,created_at,expires_at) VALUES ('synthetic_hash','grant','access',1,100);`)
    const store = createD1AuthStore(databasePort(sqlite))
    expect(await store.revokeDevice("device", "other", 2)).toBe(false)
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM mcp_grant").get()?.n).toBe(1)
    expect(await store.revokeDevice("device", "owner", 3)).toBe(true)
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM mcp_grant").get()?.n).toBe(0)
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM mcp_token").get()?.n).toBe(0)
    expect(sqlite.prepare("SELECT enabled FROM mcp_device").get()?.enabled).toBe(0)
  } finally { sqlite.close() }
})
