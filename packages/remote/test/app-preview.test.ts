import { afterEach, expect, test } from "bun:test"
import { RemoteAppPreview } from "../src/app-preview"

const origin = "https://app-one.preview.example.invalid"
const secondOrigin = "https://app-two.preview.example.invalid"
const ancestor = "https://chat.example.invalid"
const id = `app_${"a".repeat(32)}`
const generation = `generation_${"b".repeat(32)}`
const scope: RemoteAppPreview.Scope = {
  ownerID: "owner_fixture",
  deviceID: "device_fixture",
  sessionID: "ses_fixture",
  clientID: "https://client.example.invalid/client.json",
  grantID: "grant_fixture",
  epoch: "epoch_fixture",
}
const cleanup: Array<() => void> = []
afterEach(() => {
  for (const close of cleanup.splice(0)) close()
})

function fixture(options: Partial<RemoteAppPreview.Options> = {}) {
  let time = 1_000_000
  let authorized = true
  const calls: RemoteAppPreview.DispatchInput[] = []
  const checks: RemoteAppPreview.Scope[] = []
  const gateway = RemoteAppPreview.create({
    origins: [origin, secondOrigin],
    frameAncestors: [ancestor],
    now: () => time,
    authorize: async (input) => {
      checks.push(input)
      return authorized
    },
    dispatch: async (input) => {
      calls.push(input)
      return { status: 200, headers: { "content-type": "text/html" }, body: new TextEncoder().encode("fixture") }
    },
    ...options,
  })
  cleanup.push(() => gateway.close())
  const issue = (extra: Partial<RemoteAppPreview.IssueInput> = {}) =>
    gateway.issue({
      id,
      generation,
      scope,
      origin,
      entryPath: "/index.html?view=cards",
      expiresAt: time + 60_000,
      ...extra,
    })
  const redeem = async () => {
    const lease = await issue()
    const response = await gateway.fetch(new Request(lease.url))
    const cookie = response.headers.get("set-cookie")?.split(";")[0] ?? ""
    return { lease, response, cookie }
  }
  return {
    gateway,
    issue,
    redeem,
    calls,
    checks,
    advance: (ms: number) => {
      time += ms
    },
    deny: () => {
      authorized = false
    },
  }
}

test("bootstrap exchanges one private ticket for a distinct partitioned host cookie and a clean redirect", async () => {
  const f = fixture()
  const { lease, response, cookie } = await f.redeem()
  expect(Object.keys(lease).sort()).toEqual(["expiresAt", "origin", "url"])
  const ticket = new URL(lease.url).searchParams.get("ticket")
  expect(ticket).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(response.status).toBe(303)
  expect(response.headers.get("location")).toBe("/index.html?view=cards")
  expect(response.headers.get("set-cookie")).toMatch(
    /^__Host-ycoding-preview=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=None; Partitioned; Max-Age=60$/,
  )
  expect(response.headers.get("cache-control")).toBe("no-store, no-transform")
  expect(response.headers.get("referrer-policy")).toBe("no-referrer")
  expect(cookie.split("=")[1]).not.toBe(ticket)
  expect((await f.gateway.fetch(new Request(lease.url))).status).toBe(401)
  expect(f.calls).toEqual([])
  expect(f.checks).toEqual([scope])
})

test("a ticket is consumed before asynchronous authorization can admit a second redemption", async () => {
  const entered = Promise.withResolvers<void>()
  const approve = Promise.withResolvers<boolean>()
  const f = fixture({
    authorize: () => {
      entered.resolve()
      return approve.promise
    },
  })
  const lease = await f.issue()
  const first = f.gateway.fetch(new Request(lease.url))
  await entered.promise
  expect((await f.gateway.fetch(new Request(lease.url))).status).toBe(401)
  approve.resolve(true)
  expect((await first).status).toBe(303)
  expect(f.calls).toEqual([])
})

test("preview stays disabled without origins and rejects non-exact configuration", async () => {
  await expect(fixture({ origins: [] }).issue()).rejects.toMatchObject({ category: "disabled" })
  for (const candidate of [
    "https://example.invalid/path",
    "https://example.invalid/",
    "https://user@example.invalid",
    "https://*.example.invalid",
    "http://example.invalid",
    "https://example.invalid?x=1",
    "https://example.invalid#x",
  ])
    expect(() => fixture({ origins: [candidate] })).toThrow(RemoteAppPreview.Failure)
  for (const frameAncestors of [["*"], ["'self'"], ["https://chat.example.invalid/path"]])
    expect(() => fixture({ frameAncestors })).toThrow(RemoteAppPreview.Failure)
  const localOrigin = "http://127.0.0.1:4100"
  expect((await fixture({ origins: [localOrigin] }).issue({ origin: localOrigin })).origin).toBe(localOrigin)
})

test("leases validate identifier, generation, exact scope, lifetime, origin and bounded entry path", async () => {
  const f = fixture()
  for (const entryPath of [
    "//evil.invalid",
    "/../x",
    "/%2e%2e/x",
    "/%252e%252e/x",
    "/bad\\x",
    "/bad%5cx",
    "/bad%",
    "/_ycoding",
    "/_ycoding/bootstrap",
    "/x?ticket=x",
    "/x?%74icket=x",
    "/x?__Host-ycoding-preview=x",
    "/x#fragment",
    `/${"x".repeat(4096)}`,
  ])
    await expect(f.issue({ entryPath })).rejects.toMatchObject({ category: "invalid_lease" })
  for (const extra of [
    { id: "app_bad" },
    { generation: "1" },
    { origin: "https://unconfigured.invalid" },
    { expiresAt: 1_000_000 },
    { expiresAt: 1_900_001 },
    { expiresAt: 1_000_000.5 },
  ])
    await expect(f.issue(extra)).rejects.toMatchObject({ category: "invalid_lease" })
  for (const key of Object.keys(scope) as Array<keyof typeof scope>) {
    await expect(f.issue({ scope: { ...scope, [key]: "" } })).rejects.toMatchObject({ category: "invalid_lease" })
    await expect(f.issue({ scope: { ...scope, [key]: "bad\nvalue" } })).rejects.toMatchObject({
      category: "invalid_lease",
    })
  }
  await expect(f.issue({ scope: { ...scope, clientID: "x".repeat(2049) } })).rejects.toMatchObject({
    category: "invalid_lease",
  })
  await expect(
    f.issue({ scope: { ...scope, extra: "not-authority" } as RemoteAppPreview.Scope }),
  ).rejects.toMatchObject({ category: "invalid_lease" })
  expect((await f.issue({ expiresAt: 1_900_000 })).expiresAt).toBe(1_900_000)
})

test("origin bindings cannot change app, generation or any authority field after revocation or expiry", async () => {
  for (const end of ["revoke", "expire"] as const) {
    const f = fixture()
    await f.issue()
    if (end === "revoke") f.gateway.revoke({ id, generation })
    if (end === "expire") f.advance(60_000)
    for (const changed of [
      { id: `app_${"c".repeat(32)}` },
      { generation: `generation_${"d".repeat(32)}` },
      ...Object.keys(scope).map((key) => ({ scope: { ...scope, [key]: "other" } })),
    ])
      await expect(f.issue(changed)).rejects.toMatchObject({ category: "origin_bound" })
    expect((await f.issue({ origin: secondOrigin })).origin).toBe(secondOrigin)
  }
})

test("issuance snapshots all authority fields and tickets cannot cross active origins", async () => {
  const f = fixture()
  const mutableScope = { ...scope }
  const pending = f.issue({ scope: mutableScope })
  mutableScope.ownerID = "other_owner"
  mutableScope.clientID = "other_client"
  const lease = await pending
  await f.issue({ origin: secondOrigin, id: `app_${"c".repeat(32)}`, generation: `generation_${"d".repeat(32)}` })
  const stolen = new URL(lease.url)
  stolen.host = new URL(secondOrigin).host
  expect((await f.gateway.fetch(new Request(stolen.href))).status).toBe(401)
  expect((await f.gateway.fetch(new Request(lease.url))).status).toBe(303)
  expect(f.checks).toEqual([scope])
})

test("cookies are origin-bound and no bearer, query token or duplicate cookie authenticates dispatch", async () => {
  const f = fixture()
  const { cookie, lease } = await f.redeem()
  await f.issue({ origin: secondOrigin })
  for (const request of [
    new Request(`${origin}/index.html`),
    new Request(`${origin}/index.html?ticket=${new URL(lease.url).searchParams.get("ticket")}`),
    new Request(`${secondOrigin}/index.html`, { headers: { cookie } }),
    new Request(`${origin}/index.html`, { headers: { authorization: "Bearer fixture" } }),
    new Request(`${origin}/index.html`, { headers: { cookie: `${cookie}; ${cookie}` } }),
  ])
    expect((await f.gateway.fetch(request)).status).not.toBe(200)
  expect(f.calls).toEqual([])
  expect((await f.gateway.fetch(new Request(`${origin}/index.html`, { headers: { cookie } }))).status).toBe(200)
  expect(f.calls[0]?.scope).toEqual(scope)
  expect(f.checks.every((checked) => JSON.stringify(checked) === JSON.stringify(scope))).toBe(true)
})

test("bootstrap rejects extra parameters, wrong credentials and non-GET methods without dispatch", async () => {
  const f = fixture()
  const lease = await f.issue()
  for (const request of [
    new Request(`${origin}/_ycoding/bootstrap`),
    new Request(`${lease.url}&extra=value`),
    new Request(`${lease.url}&ticket=${"x".repeat(43)}`),
    new Request(`${origin}/_ycoding/bootstrap?ticket=${"x".repeat(43)}`),
  ])
    expect((await f.gateway.fetch(request)).status).toBe(401)
  expect((await f.gateway.fetch(new Request(lease.url, { method: "POST" }))).status).toBe(405)
  expect((await f.gateway.fetch(new Request(lease.url))).status).toBe(303)
  expect(f.calls).toEqual([])
})

test("unsafe methods require exact Origin and reserved paths and upgrades never dispatch", async () => {
  const f = fixture()
  const { cookie } = await f.redeem()
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    for (const headers of [new Headers({ cookie }), new Headers({ cookie, origin: secondOrigin }), new Headers({ cookie, origin: "null" })])
      expect((await f.gateway.fetch(new Request(`${origin}/api`, { method, headers }))).status).toBe(403)
  }
  expect((await f.gateway.fetch(new Request(`${origin}/_ycoding/private`, { headers: { cookie } }))).status).toBe(404)
  expect(
    (await f.gateway.fetch(new Request(`${origin}/socket`, { headers: { cookie, upgrade: "websocket" } }))).status,
  ).toBe(426)
  expect(
    (await f.gateway.fetch(new Request(`${origin}/socket`, { headers: { cookie, connection: "keep-alive, Upgrade" } })))
      .status,
  ).toBe(426)
  expect(
    (await f.gateway.fetch(new Request(`${origin}/api`, { method: "PROPFIND", headers: { cookie, origin } }))).status,
  ).toBe(405)
  expect(f.calls).toEqual([])
  expect(
    (
      await f.gateway.fetch(
        new Request(`${origin}/api?offset=2`, { method: "POST", headers: { cookie, origin }, body: "ok" }),
      )
    ).status,
  ).toBe(200)
  expect(f.calls[0]).toMatchObject({ id, generation, scope, path: "/api?offset=2", method: "POST" })
})

test("credential and hop headers are stripped while binary bytes, ranges and validators survive", async () => {
  let input: RemoteAppPreview.DispatchInput | undefined
  const f = fixture({
    dispatch: async (value) => {
      input = value
      return {
        status: 206,
        headers: {
          "content-type": "application/octet-stream",
          "content-encoding": "gzip",
          "content-length": "999",
          "content-range": "bytes 0-2/3",
          "accept-ranges": "bytes",
          etag: '"fixture"',
          "last-modified": "Mon, 01 Jan 2024 00:00:00 GMT",
          "content-disposition": 'attachment; filename="fixture.bin"',
          "set-cookie": "fixture=upstream",
          authorization: "Bearer fixture",
          "www-authenticate": "Basic fixture",
          "access-control-allow-origin": "*",
          connection: "x-private",
          "x-private": "fixture",
        },
        body: new Uint8Array([0, 127, 255]),
      }
    },
  })
  const { cookie } = await f.redeem()
  const response = await f.gateway.fetch(
    new Request(`${origin}/file`, {
      headers: {
        cookie,
        authorization: "Bearer fixture",
        "proxy-authorization": "fixture",
        "x-api-key": "fixture",
        connection: "x-private",
        "x-private": "fixture",
        range: "bytes=0-2",
        "if-none-match": '"fixture"',
      },
    }),
  )
  expect(response.status).toBe(206)
  expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual([0, 127, 255])
  expect(input?.headers).toEqual({ range: "bytes=0-2", "if-none-match": '"fixture"' })
  for (const name of [
    "cookie",
    "set-cookie",
    "authorization",
    "proxy-authorization",
    "www-authenticate",
    "access-control-allow-origin",
    "content-encoding",
    "connection",
    "x-private",
  ])
    expect(response.headers.has(name)).toBe(false)
  expect(response.headers.get("content-length")).toBe("3")
  expect(response.headers.get("content-range")).toBe("bytes 0-2/3")
  expect(response.headers.get("accept-ranges")).toBe("bytes")
  expect(response.headers.get("etag")).toBe('"fixture"')
  expect(response.headers.get("last-modified")).toBe("Mon, 01 Jan 2024 00:00:00 GMT")
  expect(response.headers.get("content-disposition")).toBe('attachment; filename="fixture.bin"')
})

test("only exact preview Origin and Referer reach the registered dispatcher", async () => {
  const f = fixture()
  const { cookie } = await f.redeem()
  await f.gateway.fetch(
    new Request(`${origin}/api`, { method: "POST", headers: { cookie, origin, referer: `${origin}/view` } }),
  )
  expect(f.calls[0]?.headers).toMatchObject({ origin, referer: `${origin}/view` })
  await f.gateway.fetch(
    new Request(`${origin}/api`, { headers: { cookie, origin: secondOrigin, referer: `${origin}.evil.invalid/view` } }),
  )
  expect(f.calls[1]?.headers).not.toHaveProperty("origin")
  expect(f.calls[1]?.headers).not.toHaveProperty("referer")
})

test("oversized declared and streamed bodies fail before dispatch and cancel the stream", async () => {
  const f = fixture()
  const { cookie } = await f.redeem()
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(65_537))
    },
    cancel() {
      cancelled = true
    },
  })
  expect(
    (
      await f.gateway.fetch(
        new Request(`${origin}/api`, { method: "POST", headers: { cookie, origin }, body: stream, duplex: "half" }),
      )
    ).status,
  ).toBe(413)
  expect(cancelled).toBe(true)
  expect(
    (
      await f.gateway.fetch(
        new Request(`${origin}/api`, {
          method: "POST",
          headers: { cookie, origin, "content-length": "65537" },
          body: "x",
        }),
      )
    ).status,
  ).toBe(413)
  expect(f.calls).toEqual([])
})

test("request and decoded response byte limits are inclusive and preserve the binary digest", async () => {
  const bytes = new Uint8Array(1_048_576).map((_, index) => index % 251)
  let received = 0
  const f = fixture({
    dispatch: async (input) => {
      received = input.body?.byteLength ?? 0
      return { status: 200, headers: { "content-type": "application/octet-stream" }, body: bytes }
    },
  })
  const { cookie } = await f.redeem()
  const response = await f.gateway.fetch(
    new Request(`${origin}/upload`, { method: "POST", headers: { cookie, origin }, body: new Uint8Array(65_536) }),
  )
  expect(response.status).toBe(200)
  expect(received).toBe(65_536)
  expect(await crypto.subtle.digest("SHA-256", await response.arrayBuffer())).toEqual(
    await crypto.subtle.digest("SHA-256", bytes),
  )
  const big = fixture({
    dispatch: async () => ({ status: 200, headers: { "content-encoding": "gzip" }, body: new Uint8Array(1_048_577) }),
  })
  const access = await big.redeem()
  expect((await big.gateway.fetch(new Request(`${origin}/file`, { headers: { cookie: access.cookie } }))).status).toBe(
    502,
  )
})

test("gateway CSP intersects application policies and retains every framing restriction", async () => {
  let connection = ""
  const f = fixture({
    dispatch: async () => ({
      status: 200,
      headers: {
        "content-security-policy": ["default-src 'none'; frame-ancestors 'none'", "script-src 'none'"],
        "content-security-policy-report-only": "connect-src 'none'",
        "x-frame-options": "DENY",
        connection,
      },
      body: new Uint8Array(),
    }),
  })
  const { cookie } = await f.redeem()
  const response = await f.gateway.fetch(new Request(`${origin}/`, { headers: { cookie } }))
  const policy = response.headers.get("content-security-policy")
  for (const directive of [
    "default-src 'none'; frame-ancestors 'none'",
    "script-src 'none'",
    `frame-ancestors ${ancestor}`,
    "worker-src 'none'",
    "connect-src 'self'",
    "object-src 'none'",
    "frame-src 'none'",
  ])
    expect(policy).toContain(directive)
  expect(response.headers.get("content-security-policy-report-only")).toBe("connect-src 'none'")
  expect(response.headers.get("x-frame-options")).toBe("DENY")
  for (const name of ["content-security-policy", "content-security-policy-report-only", "x-frame-options"]) {
    connection = name
    expect((await f.gateway.fetch(new Request(`${origin}/`, { headers: { cookie } }))).status).toBe(502)
  }
  const denied = fixture({ frameAncestors: [] })
  const access = await denied.redeem()
  expect(
    (await denied.gateway.fetch(new Request(`${origin}/`, { headers: { cookie: access.cookie } }))).headers.get(
      "content-security-policy",
    ),
  ).toContain("frame-ancestors 'none'")
})

test("redirects stay relative and cannot reach bootstrap, credentials, traversal or another origin", async () => {
  let location = "/next?view=cards"
  const f = fixture({ dispatch: async () => ({ status: 302, headers: { location }, body: new Uint8Array() }) })
  const { cookie } = await f.redeem()
  const response = await f.gateway.fetch(new Request(`${origin}/`, { headers: { cookie } }))
  expect(response.status).toBe(302)
  expect(response.headers.get("location")).toBe(location)
  for (const value of [
    "https://other.invalid/",
    "//other.invalid",
    "/_ycoding/bootstrap?ticket=x",
    "/next?ticket=x",
    "/%252e%252e/private",
    "/bad\\path",
  ]) {
    location = value
    const rejected = await f.gateway.fetch(new Request(`${origin}/`, { headers: { cookie } }))
    expect(rejected.status).toBe(502)
    expect(await rejected.text()).not.toContain(value)
  }
})

test("expiry at the exact boundary, revocation and closure invalidate both ticket and cookie", async () => {
  for (const end of ["expire", "revoke", "close"] as const) {
    const f = fixture()
    const { cookie, lease } = await f.redeem()
    if (end === "expire") f.advance(60_000)
    if (end === "revoke") f.gateway.revoke({ id, generation })
    if (end === "close") f.gateway.close()
    expect((await f.gateway.fetch(new Request(lease.url))).status).toBe(410)
    expect((await f.gateway.fetch(new Request(`${origin}/`, { headers: { cookie } }))).status).toBe(410)
    expect(f.calls).toEqual([])
  }
})

test("fresh authorization gates bootstrap, dispatch and the returned response", async () => {
  const denied = fixture()
  const lease = await denied.issue()
  denied.deny()
  const bootstrap = await denied.gateway.fetch(new Request(lease.url))
  expect(bootstrap.status).toBe(403)
  expect(bootstrap.headers.has("set-cookie")).toBe(false)
  expect(denied.calls).toEqual([])
  const before = fixture()
  const access = await before.redeem()
  before.deny()
  expect((await before.gateway.fetch(new Request(`${origin}/`, { headers: { cookie: access.cookie } }))).status).toBe(
    403,
  )
  expect(before.calls).toEqual([])
  const after = fixture({
    dispatch: async () => {
      after.deny()
      return { status: 200, headers: {}, body: new TextEncoder().encode("synthetic-private-response") }
    },
  })
  const ready = await after.redeem()
  const response = await after.gateway.fetch(new Request(`${origin}/`, { headers: { cookie: ready.cookie } }))
  expect(response.status).toBe(403)
  expect(await response.text()).not.toContain("synthetic-private-response")
})

test("authorization is checked again after a held request body and before dispatch", async () => {
  const reading = Promise.withResolvers<void>()
  const f = fixture()
  const { cookie } = await f.redeem()
  const body = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>()
  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        body.resolve(controller)
      },
      pull() {
        reading.resolve()
      },
    },
    { highWaterMark: 0 },
  )
  const pending = f.gateway.fetch(
    new Request(`${origin}/api`, { method: "POST", headers: { cookie, origin }, body: stream, duplex: "half" }),
  )
  await reading.promise
  f.deny()
  const controller = await body.promise
  controller.enqueue(new TextEncoder().encode("fixture"))
  controller.close()
  expect((await pending).status).toBe(403)
  expect(f.calls).toEqual([])
})

test("revocation, closure, observed expiry and reissuance cancel an unresolved dispatch", async () => {
  for (const end of ["revoke", "close", "expire", "reissue"] as const) {
    const entered = Promise.withResolvers<AbortSignal>()
    const f = fixture({
      dispatch: (input) => {
        entered.resolve(input.signal)
        return new Promise(() => {})
      },
    })
    const { cookie } = await f.redeem()
    const pending = f.gateway.fetch(new Request(`${origin}/`, { headers: { cookie } }))
    const signal = await entered.promise
    if (end === "revoke") f.gateway.revoke({ id, generation })
    if (end === "close") f.gateway.close()
    if (end === "expire") {
      f.advance(60_000)
      expect((await f.gateway.fetch(new Request(`${origin}/`, { headers: { cookie } }))).status).toBe(410)
    }
    if (end === "reissue") await f.issue()
    expect((await pending).status).toBe(410)
    expect(signal.aborted).toBe(true)
  }
})

test("revocation cancels pending bootstrap authorization without issuing credentials", async () => {
  const entered = Promise.withResolvers<void>()
  const f = fixture({
    authorize: () => {
      entered.resolve()
      return new Promise(() => {})
    },
  })
  const lease = await f.issue()
  const pending = f.gateway.fetch(new Request(lease.url))
  await entered.promise
  f.gateway.revoke({ id, generation })
  const response = await pending
  expect(response.status).toBe(410)
  expect(response.headers.has("set-cookie")).toBe(false)
})

test("request cancellation aborts body consumption without dispatch", async () => {
  const reading = Promise.withResolvers<void>()
  const f = fixture()
  const { cookie } = await f.redeem()
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>(
    {
      pull() {
        reading.resolve()
      },
      cancel() {
        cancelled = true
      },
    },
    { highWaterMark: 0 },
  )
  const controller = new AbortController()
  const pending = f.gateway.fetch(
    new Request(`${origin}/api`, {
      method: "POST",
      headers: { cookie, origin },
      body: stream,
      duplex: "half",
      signal: controller.signal,
    }),
  )
  await reading.promise
  controller.abort()
  expect((await pending).status).toBe(410)
  expect(cancelled).toBe(true)
  expect(f.calls).toEqual([])
})

test("reissuance replaces both credentials and a mismatched revoke cannot cancel the current generation", async () => {
  const f = fixture()
  const first = await f.redeem()
  const second = await f.redeem()
  expect((await f.gateway.fetch(new Request(first.lease.url))).status).toBe(401)
  expect((await f.gateway.fetch(new Request(`${origin}/`, { headers: { cookie: first.cookie } }))).status).toBe(401)
  f.gateway.revoke({ id, generation: `generation_${"c".repeat(32)}` })
  expect((await f.gateway.fetch(new Request(`${origin}/`, { headers: { cookie: second.cookie } }))).status).toBe(200)
})

test("HEAD retains valid representation metadata and empty statuses never send a body", async () => {
  let status = 200
  let body = new Uint8Array([1, 2, 3])
  const headers: Record<string, string> = {
    "content-type": "application/octet-stream",
    "content-length": "123",
    etag: '"fixture"',
  }
  const f = fixture({ dispatch: async () => ({ status, headers, body }) })
  const { cookie } = await f.redeem()
  const head = await f.gateway.fetch(new Request(`${origin}/file`, { method: "HEAD", headers: { cookie } }))
  expect(head.headers.get("content-length")).toBe("123")
  expect((await head.arrayBuffer()).byteLength).toBe(0)
  delete headers["content-length"]
  const measured = await f.gateway.fetch(new Request(`${origin}/file`, { method: "HEAD", headers: { cookie } }))
  expect(measured.headers.get("content-length")).toBe("3")
  headers["content-length"] = "123"
  body = new Uint8Array()
  const emptyHead = await f.gateway.fetch(new Request(`${origin}/file`, { method: "HEAD", headers: { cookie } }))
  expect(emptyHead.headers.get("content-length")).toBe("123")
  for (const next of [204, 205, 304]) {
    status = next
    for (const method of ["GET", "HEAD"]) {
      const response = await f.gateway.fetch(new Request(`${origin}/file`, { method, headers: { cookie } }))
      expect(response.status).toBe(next)
      expect(response.headers.get("etag")).toBe('"fixture"')
      expect((await response.arrayBuffer()).byteLength).toBe(0)
      if (next !== 304) expect(response.headers.has("content-length")).toBe(false)
    }
  }
})

test("SSE, invalid statuses and dependency errors fail safely without retries or upstream details", async () => {
  const results: RemoteAppPreview.DispatchResult[] = [
    { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" }, body: new Uint8Array() },
    { status: 101, headers: {}, body: new Uint8Array() },
    { status: 600, headers: {}, body: new Uint8Array() },
  ]
  for (const result of results) {
    let calls = 0
    const f = fixture({
      dispatch: async () => {
        calls++
        return result
      },
    })
    const { cookie } = await f.redeem()
    expect((await f.gateway.fetch(new Request(`${origin}/`, { headers: { cookie } }))).status).toBe(502)
    expect(calls).toBe(1)
  }
  const f = fixture({
    dispatch: async () => {
      throw new Error("http://127.0.0.1:4321/fixture?credential=synthetic")
    },
  })
  const { cookie } = await f.redeem()
  const response = await f.gateway.fetch(new Request(`${origin}/`, { headers: { cookie } }))
  expect(response.status).toBe(502)
  expect(await response.text()).toBe("upstream_unavailable")
  expect(response.headers.get("cache-control")).toBe("no-store, no-transform")
  expect(response.headers.get("referrer-policy")).toBe("no-referrer")
})
