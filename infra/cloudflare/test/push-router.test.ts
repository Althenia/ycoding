import { afterAll, beforeAll, expect, test } from "bun:test"
import { timingSafeEqual } from "node:crypto"
import { createAuthService } from "../src/auth/service"
import { base64UrlEncode } from "../src/auth/crypto"
import { createRouter } from "../src/router"
import { createD1AuthStore } from "../src/auth/d1-store"
import { createD1PushStore } from "../src/push/d1-store"
import { migratedDatabase, sqliteD1 } from "./support/d1-sqlite"
import { testEndpoints } from "./support/google"

const origin = "https://relay.test"
const adminKey = "push-admin-fixture-key".repeat(2)
const adminHeaders = { authorization: `Bearer ${adminKey}` }
const previousTimingSafeEqual = Reflect.get(crypto.subtle, "timingSafeEqual")

beforeAll(() => {
  Reflect.set(crypto.subtle, "timingSafeEqual", (left: ArrayBuffer, right: ArrayBuffer) => timingSafeEqual(Buffer.from(left), Buffer.from(right)))
})
afterAll(() => {
  if (previousTimingSafeEqual === undefined) Reflect.deleteProperty(crypto.subtle, "timingSafeEqual")
  else Reflect.set(crypto.subtle, "timingSafeEqual", previousTimingSafeEqual)
})

const allOn = { "agent-completed": true, "approval-requested": true, "machine-offline": true }

async function setup(enabled: boolean, publicKeyOverride?: string) {
  const sqlite = await migratedDatabase()
  const db = sqliteD1(sqlite)
  let clock = 100
  const authStore = createD1AuthStore(db)
  const service = createAuthService(authStore, { now: () => clock })
  const owner = await service.signIn({ provider: "google", subject: "push-owner" })
  const other = await service.signIn({ provider: "google", subject: "push-other" })
  const push = createD1PushStore(db)
  const rows = async () => new Map([...await push.list(owner.userID), ...await push.list(other.userID)].map((row) => [row.endpoint, row]))
  const sent: Request[] = []
  let pushAnswer = 201
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])
  if (!(keys instanceof Object) || !("privateKey" in keys)) throw new Error("P-256 key pair unavailable")
  const publicKey = base64UrlEncode(new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey)))
  const privateKey = (await crypto.subtle.exportKey("jwk", keys.privateKey)).d ?? ""
  const router = createRouter({ service, adminKey, relay: { getByName: () => ({ fetch: async () => new Response() }) },
    endpoints: testEndpoints(), allowedEmails: new Set(), now: () => clock,
    fetch: Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push(new Request(input, init))
      return new Response(null, { status: pushAnswer })
    }, { preconnect: globalThis.fetch.preconnect }),
    push: { store: push, ...(enabled ? { publicKey: publicKeyOverride ?? publicKey, privateKey, subject: "mailto:push@example.invalid" } : {}) } })
  const call = (method: string, path: string, token?: string, value?: unknown, headers: Record<string, string> = {}) =>
    router(new Request(`${origin}${path}`, { method, headers: { ...(token === undefined ? {} : { cookie: `yc_session=${token}` }),
      ...(value === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }) }))
  return { rows, owner, other, service, authStore, sqlite, router, call, publicKey, sent, advance: (milliseconds: number) => { clock += milliseconds },
    answer: (status: number) => { pushAnswer = status } }
}

test("push routes require a browser session and same-origin writes; unavailable keys fail clearly", async () => {
  const test = await setup(false)
  expect((await test.call("GET", "/api/push/key")).status).toBe(401)
  const key = await test.call("GET", "/api/push/key", test.owner.token)
  expect(key.status).toBe(503)
  expect(await key.json()).toMatchObject({ error: { message: "Web Push is unavailable" } })
  const input = { endpoint: "https://fcm.googleapis.com/fcm/send/a", keys: { p256dh: "BA" + "A".repeat(85), auth: "A".repeat(22) }, categories: allOn }
  expect((await test.call("POST", "/api/push/subscriptions", test.owner.token, input)).status).toBe(403)
  expect((await test.call("POST", "/api/push/subscriptions", test.owner.token, input, { origin: "https://evil.example" })).status).toBe(403)
  expect((await test.rows()).size).toBe(0)
  const invalid = await setup(true, "A".repeat(87))
  expect((await invalid.call("GET", "/api/push/key", invalid.owner.token)).status).toBe(503)
})

test("push subscriptions validate keys/endpoints, upsert with an account cap, and delete only their owner", async () => {
  const test = await setup(true)
  const key = await test.call("GET", "/api/push/key", test.owner.token)
  expect(key.status).toBe(200)
  expect(await key.json()).toEqual({ publicKey: test.publicKey })
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])
  if (!(pair instanceof Object) || !("publicKey" in pair)) throw new Error("ECDH pair unavailable")
  const p256dh = base64UrlEncode(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)))
  const auth = base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)))
  const subscribe = (endpoint: string, keys = { p256dh, auth }, token = test.owner.token) =>
    test.call("POST", "/api/push/subscriptions", token, { endpoint, keys, categories: allOn }, { origin })
  expect((await subscribe("https://evil.example/send")).status).toBe(400)
  expect((await subscribe("https://fcm.googleapis.com/send/bad", { p256dh: "short", auth })).status).toBe(400)
  for (let index = 0; index < 11; index += 1) {
    const browser = await test.service.signIn({ provider: "google", subject: "push-owner" })
    expect((await subscribe(`https://fcm.googleapis.com/fcm/send/${index}`, { p256dh, auth }, browser.token)).status).toBe(200)
  }
  expect([...(await test.rows()).values()].filter((row) => row.accountID === test.owner.userID)).toHaveLength(10)
  const endpoint = "https://fcm.googleapis.com/fcm/send/10"
  expect((await test.call("DELETE", "/api/push/subscriptions", test.other.token, { endpoint }, { origin })).status).toBe(200)
  expect((await test.rows()).has(endpoint)).toBe(true)
  expect((await test.call("DELETE", "/api/push/subscriptions", test.owner.token, { endpoint }, { origin })).status).toBe(200)
  expect((await test.rows()).has(endpoint)).toBe(false)
})

async function receiverKeys() {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])
  if (!(pair instanceof Object) || !("publicKey" in pair)) throw new Error("ECDH pair unavailable")
  return { p256dh: base64UrlEncode(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))), auth: base64UrlEncode(crypto.getRandomValues(new Uint8Array(16))) }
}

test("a device's System choices are stored with its subscription and a renewal keeps them or asks for setup again", async () => {
  const test = await setup(true)
  const keys = await receiverKeys()
  const iphone = "https://web.push.apple.com/iphone"
  const quiet = { "agent-completed": false, "approval-requested": true, "machine-offline": false }
  expect((await test.call("POST", "/api/push/subscriptions", test.owner.token, { endpoint: iphone, keys, categories: quiet }, { origin })).status).toBe(200)
  expect((await test.rows()).get(iphone)?.categories).toEqual(quiet)
  expect((await test.call("POST", "/api/push/subscriptions", test.owner.token, { endpoint: iphone, keys }, { origin })).status).toBe(400)
  const renewed = "https://web.push.apple.com/iphone-renewed"
  expect((await test.call("POST", "/api/push/subscriptions", test.other.token, { endpoint: renewed, keys, replaces: iphone }, { origin })).status).toBe(404)
  expect((await test.rows()).has(renewed)).toBe(false)
  expect((await test.call("POST", "/api/push/subscriptions", test.owner.token, { endpoint: renewed, keys, replaces: iphone }, { origin })).status).toBe(200)
  expect((await test.rows()).has(iphone)).toBe(false)
  expect((await test.rows()).get(renewed)?.categories).toEqual(quiet)
  const lost = await test.call("POST", "/api/push/subscriptions", test.owner.token, { endpoint: "https://web.push.apple.com/lost", keys, replaces: iphone }, { origin })
  expect(lost.status).toBe(404)
  expect((await test.rows()).has("https://web.push.apple.com/lost")).toBe(false)
})

test("an admin test alert reaches only the selected account's registered endpoint and reports push-service acceptance", async () => {
  const test = await setup(true)
  const keys = await receiverKeys()
  const endpoint = "https://fcm.googleapis.com/fcm/send/windows"
  expect((await test.call("POST", "/api/push/subscriptions", test.owner.token, { endpoint, keys, categories: allOn }, { origin })).status).toBe(200)
  const input = { accountID: test.owner.userID, endpoint }
  expect((await test.call("POST", "/api/admin/push/test", undefined, input)).status).toBe(401)
  expect((await test.call("POST", "/api/admin/push/test", test.owner.token, input, { origin })).status).toBe(401)
  expect((await test.call("POST", "/api/admin/push/test", undefined, input, { authorization: "Bearer wrong-key" })).status).toBe(401)
  expect((await test.call("GET", "/api/admin/push/test", undefined, undefined, adminHeaders)).status).toBe(405)
  expect((await test.call("POST", "/api/admin/push/test", undefined, { ...input, accountID: test.other.userID }, adminHeaders)).status).toBe(404)
  for (const invalid of [{ ...input, endpoint: "https://evil.example/collector" }, { endpoint }, { ...input, accountID: "" }, { ...input, accountID: "x".repeat(129) }, { ...input, keys }])
    expect((await test.call("POST", "/api/admin/push/test", undefined, invalid, adminHeaders)).status).toBe(400)
  expect((await test.call("POST", "/api/push/test", test.owner.token, { endpoint }, { origin })).status).toBe(404)
  expect(test.sent).toEqual([])
  const accepted = await test.call("POST", "/api/admin/push/test", undefined, input, adminHeaders)
  expect(accepted.status).toBe(200)
  expect(await accepted.json()).toEqual({ outcome: "accepted", status: 201 })
  expect(test.sent.map((request) => request.url)).toEqual([endpoint])
  const limited = await test.call("POST", "/api/admin/push/test", undefined, input, adminHeaders)
  expect(limited.status).toBe(429)
  expect(test.sent).toHaveLength(1)
  test.advance(60_000)
  test.answer(410)
  const expired = await test.call("POST", "/api/admin/push/test", undefined, input, adminHeaders)
  expect(await expired.json()).toEqual({ outcome: "expired", status: 410 })
  expect((await test.rows()).has(endpoint)).toBe(false)
  const disabled = await setup(false)
  expect((await disabled.call("POST", "/api/admin/push/test", undefined, { accountID: disabled.owner.userID, endpoint }, adminHeaders)).status).toBe(503)
})

test("a registration and a renewal are owned by the verified browser session that sent them, never by anything the browser supplies", async () => {
  const test = await setup(true)
  const keys = await receiverKeys()
  const laptop = await test.service.signIn({ provider: "google", subject: "push-owner" })
  const endpoint = "https://fcm.googleapis.com/fcm/send/laptop"
  const register = (token: string, value: Record<string, unknown>) => test.call("POST", "/api/push/subscriptions", token, value, { origin })
  expect((await register(laptop.token, { endpoint, keys, categories: allOn, browserSessionID: test.owner.sessionID })).status).toBe(400)
  expect((await test.rows()).size).toBe(0)
  expect((await register(laptop.token, { endpoint, keys, categories: allOn })).status).toBe(200)
  expect((await test.rows()).get(endpoint)?.browserSessionID).toBe(laptop.sessionID)
  const renewed = "https://fcm.googleapis.com/fcm/send/laptop-renewed"
  expect((await register(test.owner.token, { endpoint: renewed, keys, replaces: endpoint })).status).toBe(200)
  expect([...(await test.rows()).values()].map((row) => [row.endpoint, row.browserSessionID])).toEqual([[renewed, test.owner.sessionID]])
  expect((await register(test.owner.token, { endpoint: renewed, keys, replaces: endpoint, browserSessionID: laptop.sessionID })).status).toBe(400)
})

for (const operation of ["registration", "renewal"] as const) {
  for (const invalidation of ["rotation", "revocation", "expiry"] as const) {
    test(`${operation} rejects ${invalidation} during body processing without changing the live owner's subscription`, async () => {
      const fixture = await setup(true)
      const keys = await receiverKeys()
      const endpoint = "https://fcm.googleapis.com/send/current"
      const quiet = { "agent-completed": false, "approval-requested": true, "machine-offline": false }
      expect((await fixture.call("POST", "/api/push/subscriptions", fixture.owner.token, { endpoint, keys, categories: quiet }, { origin })).status).toBe(200)
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const request = new Request(`${origin}/api/push/subscriptions`, {
        method: "POST", headers: { cookie: `yc_session=${fixture.owner.token}`, origin, "content-type": "application/json" },
      })
      request.text = async () => {
        entered.resolve()
        await release.promise
        return JSON.stringify({ endpoint: operation === "registration" ? endpoint : "https://fcm.googleapis.com/send/renewed", keys,
          ...(operation === "registration" ? { categories: allOn } : { replaces: endpoint }) })
      }
      const response = fixture.router(request)
      await entered.promise
      if (invalidation === "rotation") {
        expect(await fixture.authStore.rotateBrowserSession(fixture.owner.sessionID,
          { id: "bs_replacement", userID: fixture.owner.userID, createdAt: 101, expiresAt: 10_000 }, 101)).toBe(true)
        expect((await fixture.rows()).get(endpoint)?.browserSessionID).toBe("bs_replacement")
      }
      if (invalidation === "revocation") await fixture.service.signOut(fixture.owner.token)
      if (invalidation === "expiry") {
        fixture.sqlite.prepare("UPDATE browser_session SET expires_at = 101 WHERE id = ?").run(fixture.owner.sessionID)
        fixture.advance(1)
      }
      const before = [...(await fixture.rows()).values()]
      release.resolve()
      const rejected = await response
      expect(rejected.status).toBe(401)
      expect(await rejected.json()).toEqual({ error: { code: "unauthorized", message: "Browser session is not authenticated" } })
      expect([...(await fixture.rows()).values()]).toEqual(before)
      expect(fixture.sent).toEqual([])
    })
  }
}
