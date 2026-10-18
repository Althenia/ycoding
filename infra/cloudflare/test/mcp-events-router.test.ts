import { expect, test } from "bun:test"
import { createAuthService } from "../src/auth/service"
import { createRouter } from "../src/router"
import { createMemoryAuthStore } from "./support/memory-store"
import { testEndpoints } from "./support/google"

const origin = "https://relay.test"
const path = "/api/devices/device/mcp/events/authorize"
const principal = { ownerID: "owner", deviceID: "device", clientID: "client" }
const resolve = { action: "resolve", requestID: "17", principal, epoch: "epoch-1" }

async function world() {
  let now = 1_000
  const store = createMemoryAuthStore()
  const service = createAuthService(store, { now: () => now })
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])
  const key = await crypto.subtle.exportKey("jwk", pair.publicKey)
  await store.insertDevice({
    id: "device",
    userID: "owner",
    name: "Synthetic device",
    publicKey: { kty: "EC", crv: "P-256", x: key.x!, y: key.y! },
    createdAt: now,
  })
  const credentials = await service.issueCredentials("device")
  if (!credentials.ok) throw new Error("Synthetic device credentials unavailable")
  const calls: { name: string; request: Request }[] = []
  const state = { rate: true, fail: false }
  const router = createRouter({
    service,
    relay: {
      getByName: (name) => ({
        fetch: async (request) => {
          calls.push({ name, request })
          if (state.fail) throw new Error("synthetic-private-adapter-detail")
          return Response.json({ action: "capabilities", supported: true })
        },
      }),
    },
    endpoints: testEndpoints(),
    allowedEmails: new Set(),
    fetch: (async () => {
      throw new Error("Unexpected external request")
    }) as typeof fetch,
    rateLimit: () => state.rate,
    now: () => now,
  })
  const request = (
    body: unknown = { action: "capabilities" },
    options: { path?: string; method?: string; headers?: Record<string, string>; raw?: string } = {},
  ) =>
    router(
      new Request(`${origin}${options.path ?? path}`, {
        method: options.method ?? "POST",
        headers: {
          authorization: `Bearer ${credentials.value.accessToken}`,
          "content-type": "application/json",
          ...options.headers,
        },
        ...((options.method ?? "POST") === "GET" ? {} : { body: options.raw ?? JSON.stringify(body) }),
      }),
    )
  return {
    store,
    service,
    calls,
    state,
    request,
    credentials: credentials.value,
    at: (value: number) => {
      now = value
    },
  }
}

test.each([
  { action: "capabilities" },
  resolve,
  { action: "check", grantID: "grant-original", principal, epoch: "epoch-1" },
])("Events device authorization forwards the exact %o contract without credentials", async (body) => {
  const value = await world()
  const response = await value.request(body, {
    headers: {
      cookie: "yc_session=synthetic-browser",
      "x-ycoding-owner": "intruder",
      "x-ycoding-device": "other",
      "x-ycoding-mcp-resource": "https://other.test/api/mcp/devices/other",
      "x-ycoding-mcp-grant": "grant-spoofed",
    },
  })
  expect(response.status).toBe(200)
  expect(response.headers.get("cache-control")).toBe("no-store")
  expect(value.calls).toHaveLength(1)
  const forwarded = value.calls[0]!
  expect(forwarded.name).toBe("owner:device")
  expect(forwarded.request.url).toBe("https://relay.internal/_ycoding/mcp-events/authorize")
  expect(forwarded.request.method).toBe("POST")
  expect(Object.fromEntries(forwarded.request.headers)).toEqual({
    "content-type": "application/json",
    "x-ycoding-internal": "1",
    "x-ycoding-owner": "owner",
    "x-ycoding-device": "device",
    "x-ycoding-mcp-resource": `${origin}/api/mcp/devices/device`,
  })
  expect(await forwarded.request.json()).toEqual(body)
})

test.each([
  ["missing", ""],
  ["unknown", "Bearer synthetic-unknown"],
  ["refresh", "refresh"],
  ["browser cookie", "cookie"],
] as const)("Events device authorization rejects %s authentication", async (_name, kind) => {
  const value = await world()
  const authorization = kind === "refresh" ? `Bearer ${value.credentials.refreshToken}` : kind === "cookie" ? "" : kind
  const response = await value.request(undefined, {
    headers: { authorization, cookie: "yc_session=synthetic-browser" },
  })
  expect(response.status).toBe(401)
  expect(value.calls).toEqual([])
})

test.each(["expired", "revoked"] as const)(
  "Events device authorization rejects a %s device credential",
  async (transition) => {
    const value = await world()
    if (transition === "expired") value.at(value.credentials.accessExpiresAt)
    if (transition === "revoked") await value.store.revokeDevice("device", "owner", 1_001)
    expect((await value.request()).status).toBe(401)
    expect(value.calls).toEqual([])
  },
)

test("Events device credential cannot authorize another device path", async () => {
  const value = await world()
  expect((await value.request(resolve, { path: "/api/devices/other/mcp/events/authorize" })).status).toBe(403)
  expect(value.calls).toEqual([])
})

test.each(
  [
    { action: "capabilities", grantID: "grant-spoofed" },
    { ...resolve, grantID: "grant-spoofed" },
    { ...resolve, resource: "https://other.test" },
    { ...resolve, requestID: "x".repeat(65) },
    { ...resolve, epoch: "x".repeat(65) },
    { ...resolve, epoch: "epoch/other" },
    { ...resolve, principal: { ...principal, ownerID: "x".repeat(65) } },
    { ...resolve, principal: { ...principal, deviceID: "x".repeat(65) } },
    { ...resolve, principal: { ...principal, clientID: "x".repeat(2049) } },
    { ...resolve, principal: { ...principal, clientID: "client\nspoofed" } },
    { ...resolve, principal: { ...principal, grantID: "grant-spoofed" } },
    { action: "resolve", principal, epoch: "epoch-1" },
    { action: "check", principal, epoch: "epoch-1" },
    { action: "unknown" },
    [],
    null,
  ].map((body) => [body] as const),
)("Events authorization rejects invalid or extra body context %o", async (body) => {
  const value = await world()
  expect((await value.request(body)).status).toBe(400)
  expect(value.calls).toEqual([])
})

test("Events authorization accepts the pinned identifier and client length boundaries", async () => {
  const value = await world()
  expect(
    (
      await value.request({
        ...resolve,
        requestID: "x".repeat(64),
        epoch: "x".repeat(64),
        principal: { ownerID: "x".repeat(64), deviceID: "x".repeat(64), clientID: "x".repeat(2048) },
      })
    ).status,
  ).toBe(200)
  expect(value.calls).toHaveLength(1)
})

test("Events device authorization rejects malformed JSON and wrong HTTP methods", async () => {
  const value = await world()
  expect((await value.request(undefined, { raw: "{" })).status).toBe(400)
  expect((await value.request(undefined, { method: "GET" })).status).toBe(405)
  expect(value.calls).toEqual([])
})

test("Events device authorization is rate limited and sanitizes adapter failures", async () => {
  const value = await world()
  value.state.rate = false
  expect((await value.request()).status).toBe(429)
  expect(value.calls).toEqual([])
  value.state.rate = true
  value.state.fail = true
  const response = await value.request()
  expect(response.status).toBe(500)
  expect(await response.text()).not.toContain("synthetic-private-adapter-detail")
})
