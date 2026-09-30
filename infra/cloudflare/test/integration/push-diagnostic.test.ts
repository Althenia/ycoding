import { expect, test } from "bun:test"
import { runInNewContext } from "node:vm"
import { generateVapidKeys } from "../../script/vapid-keys"
import { sha256Hex } from "../../src/auth/crypto"
import { vapidJwt } from "../../src/push/crypto"
import { inspectPushRequest, inspectPushResponse, parsePushDiagnostic } from "./push-diagnostic"
import { parsePushSubscription } from "../../../../packages/remote/src/index"

test("the actual Chrome bootstrap returns only endpoint and served-key hashes for receiver correlation", async () => {
  const source = await Bun.file(new URL("./chrome-push.ts", import.meta.url)).text()
  const expression = source.split("const subscribed = await evaluate(`")[1].split("`)")[0]
  const vapid = await generateVapidKeys()
  const endpoint = "https://fcm.googleapis.com/fcm/send/private-endpoint-sentinel"
  const navigator = { serviceWorker: { register: async () => ({ pushManager: { subscribe: async () => ({
    endpoint, toJSON: () => ({ keys: { p256dh: vapid.VAPID_PUBLIC_KEY, auth: "A".repeat(22) } }),
  }) } }), ready: Promise.resolve({}) } }
  let registrations = 0
  const value: unknown = await runInNewContext(expression, { navigator, Notification: { permission: "granted" }, fetch: async (url: string, init?: RequestInit) => {
    if (url === "/api/push/key") return Response.json({ publicKey: vapid.VAPID_PUBLIC_KEY })
    expect(url).toBe("/api/push/subscriptions")
    expect(typeof init?.body).toBe("string")
    if (typeof init?.body !== "string") throw new Error("Registration body missing")
    expect(parsePushSubscription(JSON.parse(init.body)).ok).toBe(true)
    registrations++
    return Response.json({ subscribed: true })
  }, window: {}, crypto, TextEncoder, atob }, { timeout: 1000 })
  expect(value).toEqual({ state: "subscribed", endpointHash: await sha256Hex(endpoint), servedPublicKeyHash: await sha256Hex(vapid.VAPID_PUBLIC_KEY) })
  expect(registrations).toBe(1)
  for (const forbidden of [endpoint, vapid.VAPID_PUBLIC_KEY, vapid.VAPID_PRIVATE_KEY]) expect(JSON.stringify(value)).not.toContain(forbidden)
})

test("verifies actual local VAPID crypto against the served key hash without retaining raw diagnostic material", async () => {
  const endpoint = "https://fcm.googleapis.com/fcm/send/private-endpoint-sentinel"
  const pair = await generateVapidKeys()
  const jwt = await vapidJwt(endpoint, pair.VAPID_PUBLIC_KEY, pair.VAPID_PRIVATE_KEY, "mailto:private-account-sentinel@example.invalid", Math.floor(Date.now() / 1000))
  const header = `vapid t=${jwt}, k=${pair.VAPID_PUBLIC_KEY}`
  const result = await inspectPushRequest(endpoint, header, await sha256Hex(pair.VAPID_PUBLIC_KEY))
  expect(result).toEqual({ endpointHash: await sha256Hex(endpoint), publicKeyMatchesServed: true, jwtVerified: true, audienceMatches: true })
  const encoded = JSON.stringify(result)
  for (const forbidden of [endpoint, header, jwt, pair.VAPID_PUBLIC_KEY, pair.VAPID_PRIVATE_KEY, "private-account-sentinel"])
    expect(encoded).not.toContain(forbidden)
  const different = await generateVapidKeys()
  expect(await inspectPushRequest(endpoint, header, await sha256Hex(different.VAPID_PUBLIC_KEY))).toMatchObject({ publicKeyMatchesServed: false, jwtVerified: false })
  expect(await inspectPushRequest("https://web.push.apple.com/private", header, await sha256Hex(pair.VAPID_PUBLIC_KEY))).toMatchObject({ jwtVerified: true, audienceMatches: false })
  const corrupted = `${jwt.slice(0, -8)}AAAAAAAA`
  expect(await inspectPushRequest(endpoint, `vapid t=${corrupted}, k=${pair.VAPID_PUBLIC_KEY}`, await sha256Hex(pair.VAPID_PUBLIC_KEY))).toMatchObject({ jwtVerified: false })
})

test("reports only allowlisted provider codes and leaves the original response unchanged", async () => {
  const raw = JSON.stringify({ error: { status: "NOT_FOUND", message: "Bearer private-header-sentinel", details: [{ errorCode: "UNREGISTERED", token: "private-token-sentinel" }] }, endpoint: "private-endpoint-sentinel", cookie: "private-cookie-sentinel", keys: "private-key-sentinel" })
  const response = new Response(raw, { status: 410, headers: { "x-private": "private-header-sentinel" } })
  expect(await inspectPushResponse(response)).toBe("UNREGISTERED")
  expect(await response.text()).toBe(raw)
  expect(response.status).toBe(410)
  expect(response.headers.get("x-private")).toBe("private-header-sentinel")
  expect(await inspectPushResponse(Response.json({ error: { code: "private-token-sentinel", status: "private-endpoint-sentinel" } }))).toBe("unreported")
  expect(await inspectPushResponse(new Response("private-cookie-sentinel"))).toBe("unreported")
  expect(await inspectPushResponse(Response.json({ error: "NotRegistered" }))).toBe("NotRegistered")
})

test("bounds provider body bytes and waiting without inventing a code from HTTP 410", async () => {
  expect(await inspectPushResponse(new Response(JSON.stringify({ error: "UNREGISTERED", padding: "x".repeat(4096) }), { status: 410 }))).toBe("unreported")
  expect(await inspectPushResponse(new Response('{"error":"UNREGISTERED"}', { headers: { "content-length": "4097" } }))).toBe("unreported")
  const hanging = new Response(new ReadableStream())
  expect(await inspectPushResponse(hanging)).toBe("unreported")
  await hanging.body?.cancel()
}, 5000)

test("rejects unsafe receiver fields, codes, and malformed hashes rather than storing them", () => {
  const safe = { endpointHash: "a".repeat(64), publicKeyMatchesServed: true, jwtVerified: true, audienceMatches: true, status: 410, providerCode: "unreported" as const }
  expect(parsePushDiagnostic(safe)).toEqual(safe)
  for (const field of ["endpoint", "headers", "jwt", "keys", "body", "cookies", "accountID"])
    expect(parsePushDiagnostic({ ...safe, [field]: "private-diagnostic-sentinel" })).toBeUndefined()
  expect(parsePushDiagnostic({ ...safe, providerCode: "private-diagnostic-sentinel" })).toBeUndefined()
  expect(parsePushDiagnostic({ ...safe, endpointHash: "private-endpoint-sentinel" })).toBeUndefined()
  expect(parsePushDiagnostic({ ...safe, status: 0 })).toBeUndefined()
})

test("the actual sending wrapper observes synthetic FCM traffic without changing the request or response", async () => {
  const source = new Bun.Transpiler({ loader: "ts" }).transformSync(await Bun.file(new URL("./push-stub-worker.ts", import.meta.url)).text())
  const script = source.slice(source.indexOf("const send = globalThis.fetch"), source.indexOf("export {"))
  const endpoint = "https://fcm.googleapis.com/fcm/send/private-endpoint-sentinel"
  const pair = await generateVapidKeys()
  const header = `vapid t=${await vapidJwt(endpoint, pair.VAPID_PUBLIC_KEY, pair.VAPID_PRIVATE_KEY, "mailto:private-account-sentinel@example.invalid", Math.floor(Date.now() / 1000))}, k=${pair.VAPID_PUBLIC_KEY}`
  const init = { method: "POST", headers: { authorization: header }, body: "private-encrypted-body-sentinel" }
  const original = Response.json({ error: { status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }], message: "private-response-sentinel" } }, { status: 410 })
  const evidence: unknown[] = []
  const context = { URL, Headers, Request, AbortSignal, inspectPushRequest, inspectPushResponse, PUSH_STUB_PORT: 12345,
    PUSH_SERVED_PUBLIC_KEY_HASH: await sha256Hex(pair.VAPID_PUBLIC_KEY), fetch: async (url: string, options?: RequestInit) => {
      if (url === endpoint) {
        expect(options).toBe(init)
        return original
      }
      expect(url).toBe("http://127.0.0.1:12345/push-diagnostic")
      if (typeof options?.body !== "string") throw new Error("Diagnostic body missing")
      const value: unknown = JSON.parse(options.body)
      expect(parsePushDiagnostic(value)).toBeDefined()
      evidence.push(value)
      throw new Error("private-receiver-failure-sentinel")
    } }
  runInNewContext(script, context, { timeout: 1000 })
  expect(await context.fetch(endpoint, init)).toBe(original)
  expect(original.status).toBe(410)
  expect(evidence).toEqual([{ endpointHash: await sha256Hex(endpoint), publicKeyMatchesServed: true, jwtVerified: true,
    audienceMatches: true, status: 410, providerCode: "UNREGISTERED" }])
  for (const forbidden of [endpoint, header, pair.VAPID_PUBLIC_KEY, pair.VAPID_PRIVATE_KEY, init.body, "private-response-sentinel", "private-receiver-failure-sentinel"])
    expect(JSON.stringify(evidence)).not.toContain(forbidden)
  expect((await original.json()).error.message).toBe("private-response-sentinel")
})

test("an unavailable diagnostic context cannot replace the original transport rejection", async () => {
  const source = new Bun.Transpiler({ loader: "ts" }).transformSync(await Bun.file(new URL("./push-stub-worker.ts", import.meta.url)).text())
  const script = source.slice(source.indexOf("const send = globalThis.fetch"), source.indexOf("export {"))
  const original = new Error("private-transport-failure-sentinel")
  let sent = false
  const context = { URL, Headers, Request, AbortSignal, inspectPushRequest, inspectPushResponse,
    fetch: async (_url: string) => { sent = true; throw original } }
  runInNewContext(script, context, { timeout: 1000 })
  await expect(context.fetch("https://fcm.googleapis.com/fcm/send/private-endpoint-sentinel")).rejects.toBe(original)
  expect(sent).toBe(true)
})
