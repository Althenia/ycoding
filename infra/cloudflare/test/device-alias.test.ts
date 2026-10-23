import { describe, expect, test } from "bun:test"
import { createRemoteHttp } from "../../../apps/web/src/remote/http"
import { createD1AuthStore } from "../src/auth/d1-store"
import { browserSessionTtlMs, createAuthService } from "../src/auth/service"
import { createRouter } from "../src/router"
import { createMemoryAuthStore } from "./support/memory-store"
import { applyMigration, migratedDatabase, sqliteD1 } from "./support/d1-sqlite"
import { testEndpoints } from "./support/google"

const origin = "https://relay.test"
const publicKey = { kty: "EC", crv: "P-256", x: "A".repeat(43), y: "A".repeat(43) } as const

async function harness() {
  let now = 1_700_000_000_000
  const store = createMemoryAuthStore()
  const service = createAuthService(store, { now: () => now })
  const owner = await service.signIn({ provider: "google", subject: "alias-owner" })
  const other = await service.signIn({ provider: "google", subject: "alias-other" })
  const second = await service.signIn({ provider: "google", subject: "alias-owner" })
  for (const [id, userID] of [["dev_one", owner.userID], ["dev_two", owner.userID], ["dev_foreign", other.userID]])
    await store.insertDevice({ id: id!, userID: userID!, name: "synthetic-host.local", publicKey, createdAt: now })
  const relayCalls: string[] = []
  const router = createRouter({ service, endpoints: testEndpoints(), allowedEmails: new Set(), now: () => now,
    fetch: Object.assign(async () => { throw new Error("Unexpected outbound request") }, { preconnect: () => {} }),
    relay: { getByName: () => ({ fetch: async (request) => { relayCalls.push(new URL(request.url).pathname); return Response.json({ online: false }) } }) },
  })
  const call = (body: unknown, options: { token?: string | null; headers?: Record<string, string>; id?: string; method?: string } = {}) =>
    router(new Request(`${origin}/api/devices/${options.id ?? "dev_one"}/alias`, {
      method: options.method ?? "PATCH",
      headers: { origin, "content-type": "application/json", ...(options.token === null ? {} : { cookie: `yc_session=${options.token ?? owner.token}` }), ...options.headers },
      ...(options.method === "GET" ? {} : { body: JSON.stringify(body) }),
    }))
  const client = (token: string) => createRemoteHttp({ baseURL: origin, fetch: Object.assign(async (input: RequestInfo | URL, init?: RequestInit) =>
    router(new Request(input, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), origin, cookie: `yc_session=${token}` } })), { preconnect: () => {} }) })
  return { store, service, owner, other, second, call, router, client, relayCalls, advance: () => { now += browserSessionTtlMs + 1 } }
}

describe("owner-shared device aliases", () => {
  test("persists an alias across owner clients and service instances without changing hostname, identity or presence", async () => {
    const h = await harness()
    const before = await h.store.findDevice("dev_one")
    const response = await h.call({ alias: "  Studio  " })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ deviceID: "dev_one", alias: "Studio" })
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(h.relayCalls).toEqual([])
    expect(await h.store.findDevice("dev_one")).toEqual({ ...before, alias: "Studio" })
    const first = await h.client(h.owner.token).me()
    const second = await h.client(h.second.token).devices()
    expect(first.ok && first.value.devices.find((device) => device.id === "dev_one")).toMatchObject({ alias: "Studio", name: "synthetic-host.local", online: false })
    expect(second.ok && second.value.find((device) => device.id === "dev_one")).toMatchObject({ alias: "Studio", name: "synthetic-host.local" })
    expect((await createAuthService(h.store).listDevices(h.owner.userID)).find((device) => device.id === "dev_one")).toMatchObject({ alias: "Studio" })
    const foreign = await h.client(h.other.token).devices()
    expect(foreign.ok && foreign.value.map((device) => device.id)).toEqual(["dev_foreign"])
    expect(JSON.stringify(foreign)).not.toContain("Studio")
  })

  test("accepts both alias length boundaries and clears with null across clients", async () => {
    const h = await harness()
    for (const alias of ["a", "x".repeat(48), "名称 🧭", "<b>literal</b>"])
      expect((await h.call({ alias })).status).toBe(200)
    expect((await h.call({ alias: "Second machine" }, { id: "dev_two" })).status).toBe(200)
    expect((await h.call({ alias: null })).status).toBe(200)
    expect((await h.call({ alias: null })).status).toBe(200)
    expect(await h.store.findDevice("dev_one")).toMatchObject({ alias: null, name: "synthetic-host.local" })
    const devices = await h.client(h.second.token).devices()
    expect(devices.ok && devices.value.find((device) => device.id === "dev_one")?.alias).toBeNull()
    expect(devices.ok && devices.value.find((device) => device.id === "dev_two")?.alias).toBe("Second machine")
  })

  test("rejects unauthenticated, expired, revoked and device-credential callers", async () => {
    const h = await harness()
    expect((await h.call({ alias: "Denied" }, { token: null })).status).toBe(401)
    const credentials = await h.service.issueCredentials("dev_one")
    if (!credentials.ok) throw new Error("Synthetic credentials were not issued")
    expect((await h.call({ alias: "Denied" }, { token: null, headers: { authorization: `Bearer ${credentials.value.accessToken}` } })).status).toBe(401)
    await h.service.signOut(h.owner.token)
    expect((await h.call({ alias: "Denied" })).status).toBe(401)
    h.advance()
    expect((await h.call({ alias: "Denied" }, { token: h.second.token })).status).toBe(401)
    expect((await h.store.findDevice("dev_one"))?.name).toBe("synthetic-host.local")
  })

  test("requires exact same-origin mutation protection", async () => {
    const h = await harness()
    for (const headers of [{ origin: "" }, { origin: "https://other.test" }, { origin, "sec-fetch-site": "cross-site" }])
      expect((await h.call({ alias: "Denied" }, { headers })).status).toBe(403)
    expect((await h.store.findDevice("dev_one"))?.alias).toBeUndefined()
  })

  test("does not update another owner, an unknown ID, or a revoked device", async () => {
    const h = await harness()
    for (const id of ["dev_foreign", "dev_missing"])
      expect((await h.call({ alias: "Denied" }, { id })).status).toBe(404)
    await h.service.revokeDevice({ deviceID: "dev_two", userID: h.owner.userID })
    expect((await h.call({ alias: "Denied" }, { id: "dev_two" })).status).toBe(404)
    expect((await h.store.findDevice("dev_foreign"))?.alias).toBeUndefined()
    expect((await h.store.findDevice("dev_two"))?.alias).toBeUndefined()
    expect((await h.call({ alias: "Denied" }, { id: "synthetic-host.local" })).status).toBe(404)
  })

  test("rejects malformed bodies and methods instead of truncating, renaming the host, or accepting owner input", async () => {
    const h = await harness()
    for (const body of [null, [], {}, { alias: "" }, { alias: "   " }, { alias: "x".repeat(49) }, { alias: 1 }, { alias: false }, { alias: {} },
      { alias: "a\nb" }, { alias: "a\u0000b" }, { alias: "Valid", name: "other-host" }, { alias: "Valid", userID: h.other.userID }, { alias: "Valid", deviceID: "dev_two" }])
      expect((await h.call(body)).status, JSON.stringify(body)).toBe(400)
    for (const method of ["GET", "POST", "PUT", "DELETE"])
      expect((await h.call({ alias: "Denied" }, { method })).status).toBe(405)
    expect(await h.store.findDevice("dev_one")).toMatchObject({ name: "synthetic-host.local" })
    expect((await h.store.findDevice("dev_one"))?.alias).toBeUndefined()
  })
})

test("the additive device alias migration preserves existing rows and atomically restricts D1 writes to active owners", async () => {
  const sqlite = await migratedDatabase("0007_push_quota_pace.sql")
  try {
    sqlite.exec(`INSERT INTO "user" (id, created_at) VALUES ('owner', 1), ('other', 1)`)
    for (const [id, owner, revoked] of [["active", "owner", null], ["revoked", "owner", 2], ["foreign", "other", null]] as const)
      sqlite.prepare("INSERT INTO device (id, user_id, name, public_key_jwk, key_algorithm, created_at, revoked_at) VALUES (?, ?, 'synthetic-host.local', ?, 'P-256', 1, ?)").run(id, owner, JSON.stringify(publicKey), revoked)
    sqlite.exec("INSERT INTO device_credential (id, device_id, kind, created_at, expires_at) VALUES ('synthetic-hash', 'active', 'access', 1, 100)")
    const before = sqlite.prepare("SELECT * FROM device ORDER BY id").all()
    await applyMigration(sqlite, "0008_device_alias.sql")
    expect(sqlite.prepare("SELECT * FROM device ORDER BY id").all()).toEqual(before.map((row) => ({ ...row, alias: null })))
    expect(sqlite.prepare("SELECT id FROM device_credential").all()).toEqual([{ id: "synthetic-hash" }])
    const store = createD1AuthStore(sqliteD1(sqlite))
    expect(await store.setDeviceAlias("active", "other", "Denied")).toBe(false)
    expect(await store.setDeviceAlias("revoked", "owner", "Denied")).toBe(false)
    expect(await store.setDeviceAlias("missing", "owner", "Denied")).toBe(false)
    expect(await store.setDeviceAlias("active", "owner", "Studio")).toBe(true)
    const reopened = createD1AuthStore(sqliteD1(sqlite))
    expect(await reopened.findDevice("active")).toMatchObject({ id: "active", name: "synthetic-host.local", alias: "Studio" })
    expect((await reopened.listDevices("owner")).find((device) => device.id === "active")?.alias).toBe("Studio")
    expect(await reopened.setDeviceAlias("active", "owner", null)).toBe(true)
    expect((await store.findDevice("active"))?.alias).toBeNull()
    for (const alias of ["", "x".repeat(49)])
      expect(() => sqlite.prepare("UPDATE device SET alias = ? WHERE id = 'active'").run(alias)).toThrow()
    expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([])
  } finally { sqlite.close() }
})
