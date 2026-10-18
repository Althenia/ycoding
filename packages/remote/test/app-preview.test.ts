import { afterEach, expect, test } from "bun:test"
import { RemoteAppPreview } from "../src/app-preview"

const origin = "https://app-one.preview.example.invalid"
const secondOrigin = "https://app-two.preview.example.invalid"
const id = `app_${"a".repeat(32)}`
const generation = `generation_${"b".repeat(32)}`
const scope: RemoteAppPreview.Scope = { ownerID: "owner_fixture", deviceID: "device_fixture", sessionID: "ses_fixture", clientID: "https://client.example.invalid/client.json", grantID: "grant_fixture", epoch: "epoch_fixture" }
const cleanup: Array<() => void> = []
afterEach(() => { for (const close of cleanup.splice(0)) close() })

function fixture(options: Partial<RemoteAppPreview.Options> = {}) {
  let time = 1_000_000
  let authorized = true
  const calls: RemoteAppPreview.DispatchInput[] = []
  const checks: RemoteAppPreview.Scope[] = []
  const gateway = RemoteAppPreview.create({
    origins: [origin, secondOrigin], frameAncestors: ["https://chat.example.invalid"], now: () => time,
    authorize: async (input) => { checks.push(input); return authorized },
    dispatch: async (input) => { calls.push(input); return { status: 200, headers: { "content-type": "text/html" }, body: new TextEncoder().encode("fixture") } },
    ...options,
  })
  cleanup.push(() => gateway.close())
  const issue = (extra: Partial<RemoteAppPreview.IssueInput> = {}) => gateway.issue({ id, generation, scope, origin, entryPath: "/index.html?view=cards", expiresAt: time + 60_000, ...extra })
  const redeem = async () => {
    const lease = await issue()
    const response = await gateway.fetch(new Request(lease.url))
    const cookie = response.headers.get("set-cookie")?.split(";")[0] ?? ""
    return { lease, response, cookie }
  }
  return { gateway, issue, redeem, calls, checks, expire: () => { time += 60_001 }, deny: () => { authorized = false } }
}

test("bootstrap creates one-use private credentials and a partitioned host cookie", async () => {
  const f = fixture()
  const { lease, response, cookie } = await f.redeem()
  expect(Object.keys(lease).sort()).toEqual(["expiresAt", "origin", "url"])
  expect(new URL(lease.url).searchParams.get("ticket")).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(response.status).toBe(303)
  expect(response.headers.get("location")).toBe("/index.html?view=cards")
  expect(response.headers.get("set-cookie")).toMatch(/^__Host-ycoding-preview=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=None; Partitioned; Max-Age=60$/)
  expect(response.headers.get("cache-control")).toBe("no-store, no-transform")
  expect(response.headers.get("referrer-policy")).toBe("no-referrer")
  expect(cookie.split("=")[1]).not.toBe(new URL(lease.url).searchParams.get("ticket"))
  expect((await f.gateway.fetch(new Request(lease.url))).status).toBe(401)
  expect(f.calls).toHaveLength(0)
  expect(f.checks).toEqual([scope])
})

test("bootstrap redemption is atomic while authorization is pending", async () => {
  let approve!: (value: boolean) => void
  let entered!: () => void
  const started = new Promise<void>((resolve) => { entered = resolve })
  const f = fixture({ authorize: () => { entered(); return new Promise<boolean>((resolve) => { approve = resolve }) } })
  const lease = await f.issue()
  const first = f.gateway.fetch(new Request(lease.url))
  await started
  expect((await f.gateway.fetch(new Request(lease.url))).status).toBe(401)
  approve(true)
  expect((await first).status).toBe(303)
})

test("default disabled configuration, exact origins, leases and entry paths fail closed", async () => {
  const f = fixture({ origins: [] })
  await expect(f.issue()).rejects.toMatchObject({ category: "disabled" })
  for (const candidate of ["https://example.invalid/path", "https://example.invalid/", "https://user@example.invalid", "https://*.example.invalid", "http://example.invalid", "https://example.invalid?x=1", "https://example.invalid#x"]) {
    expect(() => fixture({ origins: [candidate] })).toThrow(RemoteAppPreview.Failure)
  }
  expect(() => fixture({ frameAncestors: ["*"] })).toThrow(RemoteAppPreview.Failure)
  const g = fixture()
  for (const entryPath of ["//evil.invalid", "/../x", "/%2e%2e/x", "/%252e%252e/x", "/bad\\x", "/bad%5cx", "/bad%", "/_ycoding/bootstrap", "/x?ticket=x", "/x?%74icket=x", "/x#fragment"]) {
    await expect(g.issue({ entryPath })).rejects.toMatchObject({ category: "invalid_lease" })
  }
  await expect(g.issue({ origin: "https://not-approved.invalid" })).rejects.toMatchObject({ category: "invalid_lease" })
  await expect(g.issue({ expiresAt: 1_000_000 })).rejects.toMatchObject({ category: "invalid_lease" })
  await expect(g.issue({ expiresAt: 1_900_001 })).rejects.toMatchObject({ category: "invalid_lease" })
  await expect(g.issue({ scope: { ...scope, clientID: "bad\nclient" } })).rejects.toMatchObject({ category: "invalid_lease" })
  await expect(g.issue({ scope: { ...scope, clientID: "x".repeat(2049) } })).rejects.toMatchObject({ category: "invalid_lease" })
  await expect(g.issue({ generation: "1" })).rejects.toMatchObject({ category: "invalid_lease" })
  const local = fixture({ origins: ["http://127.0.0.1:4100"] })
  expect((await local.issue({ origin: "http://127.0.0.1:4100" })).origin).toBe("http://127.0.0.1:4100")
})

test("origin bindings survive revocation and cannot switch generation or any scope field", async () => {
  const f = fixture()
  await f.issue()
  f.gateway.revoke({ id, generation })
  for (const changed of [{ id: `app_${"c".repeat(32)}` }, { generation: `generation_${"d".repeat(32)}` }, ...Object.keys(scope).map((key) => ({ scope: { ...scope, [key]: "other" } }))]) {
    await expect(f.issue(changed)).rejects.toMatchObject({ category: "origin_bound" })
  }
  expect((await f.issue({ origin: secondOrigin })).origin).toBe(secondOrigin)
})

test("cookies are origin-bound; no authentication or query fallback reaches dispatch", async () => {
  const f = fixture()
  const { cookie, lease } = await f.redeem()
  for (const request of [
    new Request(`${origin}/index.html`),
    new Request(`${origin}/index.html?ticket=${new URL(lease.url).searchParams.get("ticket")}`),
    new Request(`${secondOrigin}/index.html`, { headers: { cookie } }),
    new Request(`${origin}/index.html`, { headers: { authorization: "Bearer private" } }),
    new Request(`${origin}/index.html`, { headers: { cookie: `${cookie}; ${cookie}` } }),
  ]) expect((await f.gateway.fetch(request)).status).not.toBe(200)
  expect(f.calls).toHaveLength(0)
  expect((await f.gateway.fetch(new Request(`${origin}/index.html`, { headers: { cookie } }))).status).toBe(200)
  expect(f.checks).toEqual([scope, scope, scope])
})

test("tickets cannot cross active origin registrations and issuance snapshots the full scope", async () => {
  const f = fixture()
  const mutableScope = { ...scope }
  const pending = f.issue({ scope: mutableScope })
  mutableScope.ownerID = "other_owner"
  mutableScope.clientID = "other_client"
  const first = await pending
  const second = await f.issue({ id: `app_${"c".repeat(32)}`, generation: `generation_${"d".repeat(32)}`, origin: secondOrigin, scope: { ...scope, ownerID: "other_owner" } })
  const stolen = new URL(first.url)
  stolen.host = new URL(second.origin).host
  expect((await f.gateway.fetch(new Request(stolen.toString()))).status).toBe(401)
  expect((await f.gateway.fetch(new Request(first.url))).status).toBe(303)
  expect(f.checks).toEqual([scope])
})

test("unsafe methods require exact Origin; reserved endpoints and WebSocket upgrades never dispatch", async () => {
  const f = fixture()
  const { cookie } = await f.redeem()
  const blockedHeaders: Record<string, string>[] = [{ cookie }, { cookie, origin: secondOrigin }, { cookie, origin: "null" }]
  for (const headers of blockedHeaders) {
    expect((await f.gateway.fetch(new Request(`${origin}/api`, { method: "POST", headers, body: "ok" }))).status).toBe(403)
  }
  expect((await f.gateway.fetch(new Request(`${origin}/_ycoding/private`, { headers: { cookie } }))).status).toBe(404)
  expect((await f.gateway.fetch(new Request(`${origin}/socket`, { headers: { cookie, upgrade: "websocket" } }))).status).toBe(426)
  expect(f.calls).toHaveLength(0)
  expect((await f.gateway.fetch(new Request(`${origin}/api?offset=2`, { method: "POST", headers: { cookie, origin }, body: "ok" }))).status).toBe(200)
  expect(f.calls[0]!.path).toBe("/api?offset=2")
  expect(f.calls[0]!.scope).toEqual(scope)
})

test("dispatch strips browser and server credentials, hop headers and decoded-body encoding", async () => {
  let input: RemoteAppPreview.DispatchInput | undefined
  const f = fixture({ dispatch: async (value) => {
    input = value
    return { status: 206, headers: { "content-type": "application/octet-stream", "content-encoding": "gzip", "content-length": "999", "content-range": "bytes 0-2/3", "accept-ranges": "bytes", etag: '"fixture"', "last-modified": "Mon, 01 Jan 2024 00:00:00 GMT", "content-disposition": 'attachment; filename="fixture.bin"', "set-cookie": "private=secret", authorization: "Bearer server", "access-control-allow-origin": "*", connection: "x-private", "x-private": "secret" }, body: new Uint8Array([0, 127, 255]) }
  } })
  const { cookie } = await f.redeem()
  const response = await f.gateway.fetch(new Request(`${origin}/file`, { headers: { cookie, authorization: "Bearer browser", "proxy-authorization": "private", "x-api-key": "private", connection: "x-private", "x-private": "private", range: "bytes=0-2", "if-none-match": '"fixture"' } }))
  expect(response.status).toBe(206)
  expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual([0, 127, 255])
  expect(input?.headers).toEqual({ range: "bytes=0-2", "if-none-match": '"fixture"' })
  for (const name of ["cookie", "set-cookie", "authorization", "proxy-authorization", "access-control-allow-origin", "content-encoding", "connection", "x-private"]) expect(response.headers.has(name)).toBe(false)
  expect(response.headers.get("content-length")).toBe("3")
  expect(response.headers.get("content-range")).toBe("bytes 0-2/3")
  expect(response.headers.get("etag")).toBe('"fixture"')
  expect(response.headers.get("content-disposition")).toBe('attachment; filename="fixture.bin"')
})

test("bounded request streams cancel before dispatch; binary response cap is decoded bytes", async () => {
  const f = fixture()
  const { cookie } = await f.redeem()
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(65_537)) }, cancel() { cancelled = true } })
  const request = new Request(`${origin}/api`, { method: "POST", headers: { cookie, origin }, body: stream, duplex: "half" })
  expect((await f.gateway.fetch(request)).status).toBe(413)
  expect(cancelled).toBe(true)
  expect(f.calls).toHaveLength(0)
  const big = fixture({ dispatch: async () => ({ status: 200, headers: { "content-encoding": "gzip" }, body: new Uint8Array(1_048_577) }) })
  const access = await big.redeem()
  expect((await big.gateway.fetch(new Request(`${origin}/file`, { headers: { cookie: access.cookie } }))).status).toBe(502)
})

test("exact byte limits remain usable and binary content survives by digest", async () => {
  const bytes = new Uint8Array(1_048_576).map((_, index) => index % 251)
  let received = 0
  const f = fixture({ dispatch: async (input) => {
    received = input.body?.byteLength ?? 0
    return { status: 200, headers: { "content-type": "application/octet-stream" }, body: bytes }
  } })
  const { cookie } = await f.redeem()
  const response = await f.gateway.fetch(new Request(`${origin}/upload`, { method: "POST", headers: { cookie, origin }, body: new Uint8Array(65_536) }))
  expect(response.status).toBe(200)
  expect(received).toBe(65_536)
  expect(await crypto.subtle.digest("SHA-256", await response.arrayBuffer())).toEqual(await crypto.subtle.digest("SHA-256", bytes))
})

test("gateway CSP intersects the app policy and never removes frame restrictions", async () => {
  let connection = ""
  const f = fixture({ dispatch: async () => ({ status: 200, headers: { "content-security-policy": "default-src 'none'; frame-ancestors 'none'", "x-frame-options": "DENY", connection }, body: new Uint8Array() }) })
  const { cookie } = await f.redeem()
  const response = await f.gateway.fetch(new Request(`${origin}/`, { headers: { cookie } }))
  expect(response.headers.get("content-security-policy")).toContain("default-src 'none'; frame-ancestors 'none'")
  expect(response.headers.get("content-security-policy")).toContain("frame-ancestors https://chat.example.invalid")
  expect(response.headers.get("content-security-policy")).toContain("worker-src 'none'")
  expect(response.headers.get("x-frame-options")).toBe("DENY")
  for (const value of ["content-security-policy", "x-frame-options"]) {
    connection = value
    expect((await f.gateway.fetch(new Request(`${origin}/`, { headers: { cookie } }))).status).toBe(502)
  }
  const denied = fixture({ frameAncestors: [] })
  const access = await denied.redeem()
  expect((await denied.gateway.fetch(new Request(`${origin}/`, { headers: { cookie: access.cookie } }))).headers.get("content-security-policy")).toContain("frame-ancestors 'none'")
})

test("redirects remain local and cannot reach bootstrap, credentials or external hosts", async () => {
  let location = "/next?view=cards"
  const f = fixture({ dispatch: async () => ({ status: 302, headers: { location }, body: new Uint8Array() }) })
  const { cookie } = await f.redeem()
  const request = () => f.gateway.fetch(new Request(`${origin}/`, { headers: { cookie } }))
  expect((await request()).headers.get("location")).toBe(location)
  for (const value of ["https://other.invalid/", "//other.invalid", "/_ycoding/bootstrap?ticket=x", "/next?ticket=x", "/%252e%252e/private", "/bad\\path"]) {
    location = value
    const result = await request()
    expect(result.status).toBe(502)
    expect(await result.text()).not.toContain(value)
  }
})

test("expiry, revocation and shutdown invalidate both ticket and cookie", async () => {
  for (const end of ["expire", "revoke", "close"] as const) {
    const f = fixture()
    const { cookie, lease } = await f.redeem()
    if (end === "expire") f.expire()
    if (end === "revoke") f.gateway.revoke({ id, generation })
    if (end === "close") f.gateway.close()
    expect((await f.gateway.fetch(new Request(lease.url))).status).toBe(410)
    expect((await f.gateway.fetch(new Request(`${origin}/`, { headers: { cookie } }))).status).toBe(410)
    expect(f.calls).toHaveLength(0)
  }
})

test("fresh authorization guards bootstrap and both dispatch boundaries", async () => {
  const denied = fixture()
  const lease = await denied.issue()
  denied.deny()
  expect((await denied.gateway.fetch(new Request(lease.url))).status).toBe(403)
  expect(denied.calls).toHaveLength(0)
  const before = fixture()
  const access = await before.redeem()
  before.deny()
  expect((await before.gateway.fetch(new Request(`${origin}/`, { headers: { cookie: access.cookie } }))).status).toBe(403)
  expect(before.calls).toHaveLength(0)
  const f = fixture({ dispatch: async () => { f.deny(); return { status: 200, headers: {}, body: new TextEncoder().encode("private-response") } } })
  const { cookie } = await f.redeem()
  const response = await f.gateway.fetch(new Request(`${origin}/`, { headers: { cookie } }))
  expect(response.status).toBe(403)
  expect(await response.text()).not.toContain("private-response")
  expect(f.checks).toHaveLength(3)
})

test("shutdown and expiry abort outstanding dependencies", async () => {
  for (const end of ["close", "expiry"] as const) {
    let started!: () => void
    let signal: AbortSignal | undefined
    const entered = new Promise<void>((resolve) => { started = resolve })
    const f = fixture({ now: Date.now, dispatch: (input) => { signal = input.signal; started(); return new Promise(() => {}) } })
    const lease = await f.issue({ expiresAt: Date.now() + 250 })
    const bootstrap = await f.gateway.fetch(new Request(lease.url))
    const cookie = bootstrap.headers.get("set-cookie")?.split(";")[0] ?? ""
    const pending = f.gateway.fetch(new Request(`${origin}/`, { headers: { cookie } }))
    await entered
    if (end === "close") f.gateway.close()
    expect((await pending).status).toBe(410)
    expect(signal?.aborted).toBe(true)
  }
})

test("revocation aborts in-flight dispatch even when a dependency never resolves", async () => {
  let started!: () => void
  let signal: AbortSignal | undefined
  const entered = new Promise<void>((resolve) => { started = resolve })
  const f = fixture({ dispatch: (input) => { signal = input.signal; started(); return new Promise(() => {}) } })
  const { cookie } = await f.redeem()
  const pending = f.gateway.fetch(new Request(`${origin}/`, { headers: { cookie } }))
  await entered
  f.gateway.revoke({ id, generation })
  expect((await pending).status).toBe(410)
  expect(signal?.aborted).toBe(true)
})

test("revocation aborts pending bootstrap authorization without issuing a cookie", async () => {
  let started!: () => void
  const entered = new Promise<void>((resolve) => { started = resolve })
  const f = fixture({ authorize: () => { started(); return new Promise(() => {}) } })
  const lease = await f.issue()
  const pending = f.gateway.fetch(new Request(lease.url))
  await entered
  f.gateway.revoke({ id, generation })
  const response = await pending
  expect(response.status).toBe(410)
  expect(response.headers.has("set-cookie")).toBe(false)
})

test("HEAD preserves response metadata without a body and empty statuses remain valid", async () => {
  let resultStatus = 200
  const f = fixture({ dispatch: async () => ({ status: resultStatus, headers: { "content-type": "application/octet-stream", etag: '"fixture"' }, body: new Uint8Array([1, 2, 3]) }) })
  const { cookie } = await f.redeem()
  const head = await f.gateway.fetch(new Request(`${origin}/file`, { method: "HEAD", headers: { cookie } }))
  expect(head.status).toBe(200)
  expect(head.headers.get("content-length")).toBe("3")
  expect((await head.arrayBuffer()).byteLength).toBe(0)
  for (const status of [204, 205, 304]) {
    resultStatus = status
    const response = await f.gateway.fetch(new Request(`${origin}/file`, { headers: { cookie } }))
    expect(response.status).toBe(status)
    expect(response.headers.get("etag")).toBe('"fixture"')
    expect((await response.arrayBuffer()).byteLength).toBe(0)
  }
})

test("HEAD preserves the upstream representation length when dispatch has no body", async () => {
  const f = fixture({ dispatch: async () => ({ status: 200, headers: { "content-type": "text/plain", "content-length": "123" }, body: new Uint8Array() }) })
  const { cookie } = await f.redeem()
  const response = await f.gateway.fetch(new Request(`${origin}/file`, { method: "HEAD", headers: { cookie } }))
  expect(response.headers.get("content-length")).toBe("123")
  expect((await response.arrayBuffer()).byteLength).toBe(0)
})

test("HEAD discards content length on no-content dispatcher responses", async () => {
  for (const status of [204, 205]) {
    const f = fixture({ dispatch: async () => ({ status, headers: { "content-length": "123" }, body: new Uint8Array() }) })
    const { cookie } = await f.redeem()
    const response = await f.gateway.fetch(new Request(`${origin}/file`, { method: "HEAD", headers: { cookie } }))
    expect(response.headers.has("content-length")).toBe(false)
    expect((await response.arrayBuffer()).byteLength).toBe(0)
  }
})

test("only same-origin request origin and referrer reach the registered app dispatcher", async () => {
  const f = fixture()
  const { cookie } = await f.redeem()
  await f.gateway.fetch(new Request(`${origin}/api`, { method: "POST", headers: { cookie, origin, referer: `${origin}/view` } }))
  expect(f.calls[0]!.headers).toMatchObject({ origin, referer: `${origin}/view` })
  await f.gateway.fetch(new Request(`${origin}/api`, { headers: { cookie, origin: secondOrigin, referer: `${secondOrigin}/view` } }))
  expect(f.calls[1]!.headers).not.toHaveProperty("origin")
  expect(f.calls[1]!.headers).not.toHaveProperty("referer")
})

test("SSE, invalid upstream statuses and raw dependency failures are safe and never retried", async () => {
  const responses: RemoteAppPreview.DispatchResult[] = [
    { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" }, body: new Uint8Array() },
    { status: 101, headers: {}, body: new Uint8Array() },
  ]
  for (const result of responses) {
    let calls = 0
    const f = fixture({ dispatch: async () => { calls++; return result } })
    const { cookie } = await f.redeem()
    expect((await f.gateway.fetch(new Request(`${origin}/`, { headers: { cookie } }))).status).toBe(502)
    expect(calls).toBe(1)
  }
  const f = fixture({ dispatch: async () => { throw new Error("private-upstream-url-and-cookie") } })
  const { cookie } = await f.redeem()
  const response = await f.gateway.fetch(new Request(`${origin}/`, { headers: { cookie } }))
  expect(response.status).toBe(502)
  expect(await response.text()).not.toContain("private")
})
