import { expect, test } from "bun:test"
import { createAuthService } from "../src/auth/service"
import { base64UrlEncode } from "../src/auth/crypto"
import { createRouter } from "../src/router"
import type { PushStore, PushSubscription } from "../src/push/store"
import { createMemoryAuthStore } from "./support/memory-store"
import { testEndpoints } from "./support/google"

const origin = "https://relay.test"

const allOn = { "agent-completed": true, "approval-requested": true, "machine-offline": true }

async function setup(enabled: boolean, publicKeyOverride?: string) {
  const service = createAuthService(createMemoryAuthStore())
  const owner = await service.signIn({ provider: "google", subject: "push-owner" })
  const other = await service.signIn({ provider: "google", subject: "push-other" })
  const rows = new Map<string, PushSubscription>()
  const tested = new Map<string, number>()
  const retain = (accountID: string) => {
    const owned = [...rows.values()].filter((row) => row.accountID === accountID).sort((a, b) => b.createdAt - a.createdAt || b.endpoint.localeCompare(a.endpoint))
    owned.slice(10).forEach((row) => rows.delete(row.endpoint))
  }
  const push: PushStore = {
    upsert: async (accountID, input, now) => {
      rows.set(input.endpoint, { ...input, accountID, createdAt: now, failures: 0 })
      retain(accountID)
    },
    renew: async (accountID, input, now) => {
      const old = rows.get(input.replaces)
      if (old?.accountID !== accountID) return false
      rows.delete(input.replaces)
      rows.set(input.endpoint, { endpoint: input.endpoint, keys: input.keys, categories: old.categories, accountID, createdAt: now, failures: 0 })
      retain(accountID)
      return true
    },
    remove: async (accountID, endpoint) => { if (rows.get(endpoint)?.accountID === accountID) rows.delete(endpoint) },
    list: async (accountID) => [...rows.values()].filter((row) => row.accountID === accountID),
    claimTest: async (accountID, endpoint, now) => {
      const row = rows.get(endpoint)
      if (row?.accountID !== accountID) return { status: "missing" }
      if (now - (tested.get(endpoint) ?? -Infinity) < 60_000) return { status: "limited" }
      tested.set(endpoint, now)
      return { status: "claimed", subscription: row }
    },
    recordFailure: async (row, permanent) => { if (permanent) rows.delete(row.endpoint) },
  }
  const sent: Request[] = []
  let clock = 100
  let pushAnswer = 201
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])
  if (!(keys instanceof Object) || !("privateKey" in keys)) throw new Error("P-256 key pair unavailable")
  const publicKey = base64UrlEncode(new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey)))
  const privateKey = (await crypto.subtle.exportKey("jwk", keys.privateKey)).d ?? ""
  const router = createRouter({ service, relay: { getByName: () => ({ fetch: async () => new Response() }) },
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
  return { rows, owner, other, call, publicKey, sent, advance: (milliseconds: number) => { clock += milliseconds },
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
  expect(test.rows.size).toBe(0)
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
  for (let index = 0; index < 11; index += 1)
    expect((await subscribe(`https://fcm.googleapis.com/fcm/send/${index}`)).status).toBe(200)
  expect([...test.rows.values()].filter((row) => row.accountID === test.owner.userID)).toHaveLength(10)
  const endpoint = "https://fcm.googleapis.com/fcm/send/10"
  expect((await test.call("DELETE", "/api/push/subscriptions", test.other.token, { endpoint }, { origin })).status).toBe(200)
  expect(test.rows.has(endpoint)).toBe(true)
  expect((await test.call("DELETE", "/api/push/subscriptions", test.owner.token, { endpoint }, { origin })).status).toBe(200)
  expect(test.rows.has(endpoint)).toBe(false)
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
  expect(test.rows.get(iphone)?.categories).toEqual(quiet)
  expect((await test.call("POST", "/api/push/subscriptions", test.owner.token, { endpoint: iphone, keys }, { origin })).status).toBe(400)
  const renewed = "https://web.push.apple.com/iphone-renewed"
  expect((await test.call("POST", "/api/push/subscriptions", test.other.token, { endpoint: renewed, keys, replaces: iphone }, { origin })).status).toBe(404)
  expect(test.rows.has(renewed)).toBe(false)
  expect((await test.call("POST", "/api/push/subscriptions", test.owner.token, { endpoint: renewed, keys, replaces: iphone }, { origin })).status).toBe(200)
  expect(test.rows.has(iphone)).toBe(false)
  expect(test.rows.get(renewed)?.categories).toEqual(quiet)
  const lost = await test.call("POST", "/api/push/subscriptions", test.owner.token, { endpoint: "https://web.push.apple.com/lost", keys, replaces: iphone }, { origin })
  expect(lost.status).toBe(404)
  expect(test.rows.has("https://web.push.apple.com/lost")).toBe(false)
})

test("a test alert reaches only the caller's own stored subscription, once a minute, and answers with the push service outcome only", async () => {
  const test = await setup(true)
  const keys = await receiverKeys()
  const endpoint = "https://fcm.googleapis.com/fcm/send/windows"
  expect((await test.call("POST", "/api/push/subscriptions", test.owner.token, { endpoint, keys, categories: allOn }, { origin })).status).toBe(200)
  expect((await test.call("POST", "/api/push/test", undefined, { endpoint }, { origin })).status).toBe(401)
  expect((await test.call("POST", "/api/push/test", test.owner.token, { endpoint }, { origin: "https://evil.example" })).status).toBe(403)
  expect((await test.call("GET", "/api/push/test", test.owner.token)).status).toBe(405)
  expect((await test.call("POST", "/api/push/test", test.other.token, { endpoint }, { origin })).status).toBe(404)
  expect((await test.call("POST", "/api/push/test", test.owner.token, { endpoint: "https://evil.example/collector" }, { origin })).status).toBe(400)
  expect(test.sent).toEqual([])
  const accepted = await test.call("POST", "/api/push/test", test.owner.token, { endpoint }, { origin })
  expect(accepted.status).toBe(200)
  expect(await accepted.json()).toEqual({ outcome: "accepted", status: 201 })
  expect(test.sent.map((request) => request.url)).toEqual([endpoint])
  const limited = await test.call("POST", "/api/push/test", test.owner.token, { endpoint }, { origin })
  expect(limited.status).toBe(429)
  expect(test.sent).toHaveLength(1)
  test.advance(60_000)
  test.answer(410)
  const expired = await test.call("POST", "/api/push/test", test.owner.token, { endpoint }, { origin })
  expect(await expired.json()).toEqual({ outcome: "expired", status: 410 })
  expect(test.rows.has(endpoint)).toBe(false)
  const disabled = await setup(false)
  expect((await disabled.call("POST", "/api/push/test", disabled.owner.token, { endpoint }, { origin })).status).toBe(503)
})
