import { expect, test } from "bun:test"
import { createAuthService } from "../src/auth/service"
import { base64UrlEncode } from "../src/auth/crypto"
import { createRouter } from "../src/router"
import type { PushStore, PushSubscription } from "../src/push/store"
import { createMemoryAuthStore } from "./support/memory-store"
import { testEndpoints } from "./support/google"

const origin = "https://relay.test"

async function setup(enabled: boolean, publicKeyOverride?: string) {
  const service = createAuthService(createMemoryAuthStore())
  const owner = await service.signIn({ provider: "google", subject: "push-owner" })
  const other = await service.signIn({ provider: "google", subject: "push-other" })
  const rows = new Map<string, PushSubscription>()
  const push: PushStore = {
    upsert: async (accountID, input, now) => {
      rows.set(input.endpoint, { ...input, accountID, createdAt: now, failures: 0 })
      const owned = [...rows.values()].filter((row) => row.accountID === accountID).sort((a, b) => b.createdAt - a.createdAt || b.endpoint.localeCompare(a.endpoint))
      owned.slice(10).forEach((row) => rows.delete(row.endpoint))
    },
    remove: async (accountID, endpoint) => { if (rows.get(endpoint)?.accountID === accountID) rows.delete(endpoint) },
    list: async (accountID) => [...rows.values()].filter((row) => row.accountID === accountID),
    recordFailure: async () => undefined,
  }
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])
  if (!(keys instanceof Object) || !("privateKey" in keys)) throw new Error("P-256 key pair unavailable")
  const publicKey = base64UrlEncode(new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey)))
  const privateKey = (await crypto.subtle.exportKey("jwk", keys.privateKey)).d ?? ""
  const router = createRouter({ service, relay: { getByName: () => ({ fetch: async () => new Response() }) },
    endpoints: testEndpoints(), allowedEmails: new Set(), fetch: globalThis.fetch, now: () => 100,
    push: { store: push, ...(enabled ? { publicKey: publicKeyOverride ?? publicKey, privateKey, subject: "mailto:push@example.invalid" } : {}) } })
  const call = (method: string, path: string, token?: string, value?: unknown, headers: Record<string, string> = {}) =>
    router(new Request(`${origin}${path}`, { method, headers: { ...(token === undefined ? {} : { cookie: `yc_session=${token}` }),
      ...(value === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }) }))
  return { rows, owner, other, call, publicKey }
}

test("push routes require a browser session and same-origin writes; unavailable keys fail clearly", async () => {
  const test = await setup(false)
  expect((await test.call("GET", "/api/push/key")).status).toBe(401)
  const key = await test.call("GET", "/api/push/key", test.owner.token)
  expect(key.status).toBe(503)
  expect(await key.json()).toMatchObject({ error: { message: "Web Push is unavailable" } })
  const input = { endpoint: "https://fcm.googleapis.com/fcm/send/a", keys: { p256dh: "BA" + "A".repeat(85), auth: "A".repeat(22) } }
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
    test.call("POST", "/api/push/subscriptions", token, { endpoint, keys }, { origin })
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
