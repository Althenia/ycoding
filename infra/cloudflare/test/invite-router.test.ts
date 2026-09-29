import { afterAll, beforeAll, expect, test } from "bun:test"
import { timingSafeEqual } from "node:crypto"
import { Database } from "bun:sqlite"
import { createD1AuthStore } from "../src/auth/d1-store"
import { createAuthService } from "../src/auth/service"
import { createD1InviteStore } from "../src/invite/d1-store"
import { createInviteService } from "../src/invite/service"
import { createRouter } from "../src/router"
import { testEndpoints } from "./support/google"

const origin = "https://relay.test"
const adminKey = "A".repeat(40)
const previousTimingSafeEqual = Reflect.get(crypto.subtle, "timingSafeEqual")

beforeAll(() => {
  Reflect.set(crypto.subtle, "timingSafeEqual", (left: ArrayBuffer, right: ArrayBuffer) => timingSafeEqual(Buffer.from(left), Buffer.from(right)))
})
afterAll(() => {
  if (previousTimingSafeEqual === undefined) Reflect.deleteProperty(crypto.subtle, "timingSafeEqual")
  else Reflect.set(crypto.subtle, "timingSafeEqual", previousTimingSafeEqual)
})

function databasePort(sqlite: Database): D1Database {
  const value: unknown = {
    prepare: (sql: string) => ({ bind: (...values: (string | number | null)[]) => ({
      run: async () => ({ meta: { changes: sqlite.prepare(sql).run(...values).changes } }),
      all: async () => ({ results: sqlite.prepare(sql).all(...values) }),
      first: async () => sqlite.prepare(sql).get(...values),
    }), all: async () => ({ results: sqlite.prepare(sql).all() }) }),
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
  if (typeof value !== "object" || value === null || typeof Reflect.get(value, "prepare") !== "function") throw new Error("D1 port unavailable")
  return value
}

async function harness(options: { readonly key?: string } = { key: adminKey }) {
  const sqlite = new Database(":memory:")
  sqlite.exec("PRAGMA foreign_keys = ON")
  sqlite.exec(await Bun.file(new URL("../migrations/0001_auth.sql", import.meta.url)).text())
  sqlite.exec(await Bun.file(new URL("../migrations/0002_push.sql", import.meta.url)).text())
  sqlite.exec(await Bun.file(new URL("../migrations/0003_invite.sql", import.meta.url)).text())
  const service = createAuthService(createD1AuthStore(databasePort(sqlite)), { now: () => 100 })
  const closed: string[] = []
  const router = createRouter({ service, invite: createInviteService(createD1InviteStore(databasePort(sqlite)), () => 100), adminKey: options.key,
    endpoints: testEndpoints(), allowedEmails: new Set(), fetch: globalThis.fetch, now: () => 100,
    relay: { getByName: (name) => ({ fetch: async (request) => { closed.push(`${name}:${new URL(request.url).pathname}`); return new Response(null, { status: 204 }) } }) } })
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => router(new Request(`${origin}${path}`, {
    method, headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }))
  const admin = (method: string, path: string, body?: unknown, bearer = adminKey) =>
    call(method, path, body, { authorization: `Bearer ${bearer}`, origin })
  const redeem = (token: string, headers: Record<string, string> = {}) => call("POST", "/api/auth/invite", { token }, { origin, ...headers })
  const signIn = (accessKey: string, headers: Record<string, string> = {}) => call("POST", "/api/auth/key", { accessKey }, { origin, ...headers })
  return { sqlite, service, closed, call, admin, redeem, signIn }
}

test("admin routes fail closed, compare bearer securely, bound failed attempts, and never cache", async () => {
  for (const key of [undefined, "short"]) {
    const h = await harness({ key })
    expect((await h.admin("GET", "/api/admin/invites")).status).toBe(404)
    h.sqlite.close()
  }
  const h = await harness()
  try {
    for (const bearer of ["", "wrong"]) {
      const response = await h.admin("GET", "/api/admin/invites", undefined, bearer)
      expect(response.status).toBe(401)
      expect(response.headers.get("cache-control")).toBe("no-store")
    }
    for (let attempt = 0; attempt < 28; attempt += 1) expect((await h.admin("GET", "/api/admin/invites", undefined, "wrong")).status).toBe(401)
    expect((await h.admin("GET", "/api/admin/invites", undefined, "wrong")).status).toBe(429)
    expect((await h.admin("GET", "/api/admin/invites")).status).toBe(200)
    expect((await h.call("GET", "/api/admin/invites", undefined, { authorization: "Bearer wrong", "cf-connecting-ip": "another-client" })).status).toBe(401)
    expect((await h.call("GET", "/api/admin/invites", undefined, { cookie: "yc_session=irrelevant" })).status).toBe(429)
  } finally { h.sqlite.close() }
})

test("create, list, and validate labeled or unlabeled single-use fragment invites", async () => {
  const h = await harness()
  try {
    for (const label of ["", "x".repeat(65), 3]) expect((await h.admin("POST", "/api/admin/invites", { label })).status).toBe(400)
    const first = await h.admin("POST", "/api/admin/invites", { label: "  Teammate  " })
    expect(first.status).toBe(201)
    expect(first.headers.get("cache-control")).toBe("no-store")
    const created = await first.json()
    expect(created.id).toMatch(/^inv_/)
    expect(created.label).toBe("Teammate")
    expect(created.createdAt).toBe(100)
    expect(created.url).toMatch(/^https:\/\/relay\.test\/remote\/invite#[A-Za-z0-9_-]{43}$/)
    const second = await h.admin("POST", "/api/admin/invites", {})
    expect(second.status).toBe(201)
    const listed = await h.admin("GET", "/api/admin/invites")
    expect(listed.status).toBe(200)
    expect(listed.headers.get("cache-control")).toBe("no-store")
    expect(await listed.json()).toEqual({ invites: [
      { id: (await second.json()).id, label: null, createdAt: 100, redeemedAt: null },
      { id: created.id, label: "Teammate", createdAt: 100, redeemedAt: null },
    ].sort((a, b) => a.id < b.id ? 1 : -1) })
    expect(JSON.stringify(await (await h.admin("GET", "/api/admin/invites")).json())).not.toContain(created.url.split("#")[1])
  } finally { h.sqlite.close() }
})

test("redemption is atomic and once-only, and a key signs in another browser until admin deletion", async () => {
  const h = await harness()
  try {
    const created = await (await h.admin("POST", "/api/admin/invites", {})).json()
    const token = created.url.split("#")[1]
    const [first, second] = await Promise.all([h.redeem(token), h.redeem(token)])
    expect([first.status, second.status].sort((a, b) => a - b)).toEqual([201, 404])
    const winner = first.status === 201 ? first : second
    expect(winner.headers.get("cache-control")).toBe("no-store")
    expect((first.status === 404 ? first : second).headers.get("cache-control")).toBe("no-store")
    const { accessKey } = await winner.json()
    expect(accessKey).toMatch(/^(?:[0-9A-HJKMNP-TV-Z]{4}-){7}[0-9A-HJKMNP-TV-Z]{4}$/)
    expect(winner.headers.get("set-cookie")).toContain("HttpOnly; Secure; SameSite=Lax")
    expect((await h.redeem(token)).status).toBe(404)
    expect(h.sqlite.prepare('SELECT COUNT(*) AS count FROM "user"').get()).toEqual({ count: 1 })
    expect(h.sqlite.prepare("SELECT COUNT(*) AS count FROM browser_session").get()).toEqual({ count: 1 })
    const secondBrowser = await h.signIn(accessKey.toLowerCase().replaceAll("-", " "))
    expect(secondBrowser.status).toBe(204)
    expect(secondBrowser.headers.get("cache-control")).toBe("no-store")
    const session = secondBrowser.headers.get("set-cookie")?.split(";")[0]
    expect((await h.call("GET", "/api/me", undefined, { cookie: session ?? "" })).status).toBe(200)
    const deleted = await h.admin("DELETE", `/api/admin/invites/${created.id}`)
    expect(deleted.status).toBe(204)
    expect(deleted.headers.get("cache-control")).toBe("no-store")
    expect((await h.call("GET", "/api/me", undefined, { cookie: winner.headers.get("set-cookie")?.split(";")[0] ?? "" })).status).toBe(401)
    expect((await h.call("GET", "/api/me", undefined, { cookie: session ?? "" })).status).toBe(401)
    expect((await h.signIn(accessKey)).status).toBe(401)
    expect((await h.admin("DELETE", `/api/admin/invites/${created.id}`)).status).toBe(404)
  } finally { h.sqlite.close() }
})

test("invalid key and cross-origin auth attempts are rejected without access or cache", async () => {
  const h = await harness()
  try {
    for (const value of ["short", "Z".repeat(32), "O".repeat(31), "I".repeat(33)]) {
      const response = await h.signIn(value)
      expect(response.status).toBe(401)
      expect(response.headers.get("cache-control")).toBe("no-store")
    }
    expect((await h.call("POST", "/api/auth/key", { accessKey: "bad" })).status).toBe(403)
    expect((await h.call("POST", "/api/auth/invite", { token: "bad" }, { origin: "https://evil.test", "sec-fetch-site": "cross-site" })).status).toBe(403)
    for (let attempt = 0; attempt < 24; attempt += 1) expect((await h.signIn("bad")).status).toBe(401)
    expect((await h.signIn("bad")).status).toBe(429)
  } finally { h.sqlite.close() }
})

test("deleting a redeemed invite closes every machine and removes every account-linked row", async () => {
  const h = await harness()
  try {
    const created = await (await h.admin("POST", "/api/admin/invites", {})).json()
    expect((await h.redeem(created.url.split("#")[1])).status).toBe(201)
    const userID = h.sqlite.prepare("SELECT user_id FROM invite WHERE id = ?").get(created.id)?.user_id
    if (typeof userID !== "string") throw new Error("Redeemed invite has no account")
    h.sqlite.prepare("INSERT INTO identity (provider, subject, user_id, created_at) VALUES ('google', 'test', ?, 1)").run(userID)
    h.sqlite.prepare("INSERT INTO oauth_transaction (id, state_hash, nonce, code_verifier, redirect_after, created_at, expires_at, user_id) VALUES ('tx', 'hash', 'nonce', 'verifier', '/remote', 1, 200, ?)").run(userID)
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])
    const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey)
    const publicKey = JSON.stringify({ kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y })
    for (const id of ["dev_one", "dev_two"]) {
      h.sqlite.prepare("INSERT INTO device (id, user_id, name, public_key_jwk, key_algorithm, created_at) VALUES (?, ?, 'Device', ?, 'P-256', 1)").run(id, userID, publicKey)
      h.sqlite.prepare("INSERT INTO device_credential (id, device_id, kind, created_at, expires_at) VALUES (?, ?, 'access', 1, 200)").run(`cred_${id}`, id)
      h.sqlite.prepare("INSERT INTO device_challenge (id, device_id, nonce, created_at, expires_at) VALUES (?, ?, 'nonce', 1, 200)").run(`chl_${id}`, id)
      h.sqlite.prepare("INSERT INTO enrollment (id, code_hash, user_id, created_at, expires_at, device_id) VALUES (?, 'hash', ?, 1, 200, ?)").run(`enr_${id}`, userID, id)
    }
    h.sqlite.prepare("INSERT INTO push_subscription (endpoint, account_id, p256dh, auth, created_at) VALUES ('https://push.test', ?, 'key', 'auth', 1)").run(userID)
    const deleted = await h.admin("DELETE", `/api/admin/invites/${created.id}`)
    expect(h.closed).toHaveLength(2)
    expect(deleted.status).toBe(204)
    expect(h.closed).toEqual([`${userID}:dev_one:/_ycoding/close-device`, `${userID}:dev_two:/_ycoding/close-device`])
    for (const table of ["invite", "user", "identity", "browser_session", "device", "device_credential", "device_challenge", "enrollment", "push_subscription", "oauth_transaction"])
      expect({ table, count: h.sqlite.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get()?.count }).toEqual({ table, count: 0 })
  } finally { h.sqlite.close() }
})

test("a new invite or access-key cookie revokes an existing browser session and closes its live sockets", async () => {
  const h = await harness()
  try {
    const previous = await h.service.signIn({ provider: "google", subject: "operator" })
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])
    const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey)
    h.sqlite.prepare("INSERT INTO device (id, user_id, name, public_key_jwk, key_algorithm, created_at) VALUES ('dev_prior', ?, 'Prior', ?, 'P-256', 1)")
      .run(previous.userID, JSON.stringify({ kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y }))
    const invite = await (await h.admin("POST", "/api/admin/invites", {})).json()
    const accepted = await h.redeem(invite.url.split("#")[1], { cookie: `yc_session=${previous.token}` })
    expect(accepted.status).toBe(201)
    const firstCookie = accepted.headers.get("set-cookie")?.split(";")[0] ?? ""
    const invited = await (await h.call("GET", "/api/me", undefined, { cookie: firstCookie })).json()
    expect(invited.user.id).not.toBe(previous.userID)
    expect((await h.call("GET", "/api/me", undefined, { cookie: `yc_session=${previous.token}` })).status).toBe(401)
    expect(h.closed).toEqual([`${previous.userID}:dev_prior:/_ycoding/revoke-session`])
    const key = (await accepted.json()).accessKey
    const next = await h.signIn(key, { cookie: firstCookie })
    expect(next.status).toBe(204)
    expect((await h.call("GET", "/api/me", undefined, { cookie: firstCookie })).status).toBe(401)
    expect((await h.call("GET", "/api/me", undefined, { cookie: next.headers.get("set-cookie")?.split(";")[0] ?? "" })).status).toBe(200)
    const operator = await h.service.signIn({ provider: "google", subject: "operator" })
    expect(operator.userID).toBe(previous.userID)
    expect((await h.admin("DELETE", `/api/admin/invites/${invite.id}`)).status).toBe(204)
    expect((await h.call("GET", "/api/me", undefined, { cookie: `yc_session=${operator.token}` })).status).toBe(200)
  } finally { h.sqlite.close() }
})

test("invite and key credentials remain hashed and no route logs credential material", async () => {
  const h = await harness()
  const logged: string[] = []
  const previous = { log: console.log, warn: console.warn, error: console.error }
  console.log = (...args) => { logged.push(JSON.stringify(args)) }
  console.warn = (...args) => { logged.push(JSON.stringify(args)) }
  console.error = (...args) => { logged.push(JSON.stringify(args)) }
  try {
    const created = await (await h.admin("POST", "/api/admin/invites", {})).json()
    const token = created.url.split("#")[1]
    const accepted = await (await h.redeem(token)).json()
    const key = accepted.accessKey
    const rows = h.sqlite.prepare("SELECT token_hash, key_hash FROM invite").all()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ token_hash: expect.stringMatching(/^[0-9a-f]{64}$/), key_hash: expect.stringMatching(/^[0-9a-f]{64}$/) })
    expect(JSON.stringify(rows)).not.toContain(token)
    expect(JSON.stringify(rows)).not.toContain(key)
    expect(JSON.stringify(logged)).not.toContain(token)
    expect(JSON.stringify(logged)).not.toContain(key)
    expect(JSON.stringify(logged)).not.toContain(adminKey)
  } finally {
    console.log = previous.log
    console.warn = previous.warn
    console.error = previous.error
    h.sqlite.close()
  }
})
