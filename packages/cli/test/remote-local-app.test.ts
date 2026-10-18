import { describe, expect, test } from "bun:test"
import { RemoteLocalApp } from "../src/remote-local-app"

const owner = { ownerID: "owner", deviceID: "device", sessionID: "session" }
const scope = { ...owner, clientID: "client", grantID: "grant", epoch: "epoch" }
const registration = {
  sessionID: owner.sessionID,
  host: "127.0.0.1",
  port: 43210,
  entryPath: "/app/index.html",
  routes: [{ path: "/app", match: "prefix", methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] }],
} satisfies RemoteLocalApp.Input

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function harness(options: Partial<RemoteLocalApp.Options> = {}) {
  const calls: { url: string; init: RequestInit }[] = []
  const registry = RemoteLocalApp.create({
    now: () => 1_000,
    verifySession: async () => true,
    authorize: async () => true,
    fetcher: async (url, init) => {
      calls.push({ url: typeof url === "string" ? url : url instanceof URL ? url.href : url.url, init: init ?? {} })
      return new Response("ok", { headers: { "content-type": "text/plain" } })
    },
    ...options,
  })
  const add = async (input: RemoteLocalApp.Input = registration, identity: RemoteLocalApp.Owner = owner) => {
    const app = await registry.register(input, identity)
    registry.publish({ id: app.id, generation: app.generation, owner: identity, scope: { ...scope, ...identity } })
    return app
  }
  const send = (app: RemoteLocalApp.Registration, overrides: Partial<RemoteLocalApp.Request> = {}) => registry.dispatch({
    id: app.id, generation: app.generation, scope, method: "GET", path: app.entryPath, headers: {}, ...overrides,
  })
  return { registry, calls, add, send }
}

async function category(result: Promise<unknown>) {
  const error = await result.then(() => undefined, (cause: unknown) => cause)
  expect(error).toBeInstanceOf(RemoteLocalApp.Error)
  if (!(error instanceof RemoteLocalApp.Error)) throw error
  expect(error.message).toBe(error.category)
  expect("cause" in error).toBe(false)
  expect(JSON.stringify(error)).not.toMatch(/43210|upstream-secret|127\.0\.0\.1/)
  return error.category
}

test("HEAD retains an unencoded upstream representation length without a body", async () => {
  const h = harness({ fetcher: async () => new Response(null, { headers: { "content-length": "123", "content-type": "text/plain" } }) })
  try {
    const result = await h.send(await h.add(), { method: "HEAD" })
    expect(result.body.byteLength).toBe(0)
    expect(result.headers["content-length"]).toBe("123")
  } finally { h.registry.close() }
})

test("HEAD discards content length on no-content responses", async () => {
  for (const status of [204, 205]) {
    const h = harness({ fetcher: async () => new Response(null, { status, headers: { "content-length": "123" } }) })
    try {
      const result = await h.send(await h.add(), { method: "HEAD" })
      expect(result.body.byteLength).toBe(0)
      expect(result.headers).not.toHaveProperty("content-length")
    } finally { h.registry.close() }
  }
})

describe("local HTTP app registration and publication", () => {
  test("returns detached safe metadata and requires an explicit single-scope publication", async () => {
    const h = harness()
    try {
      const app = await h.registry.register(registration, owner)
      expect(app.id).toMatch(/^app_[a-f0-9]{32}$/)
      expect(app.generation).toMatch(/^generation_[a-f0-9]{32}$/)
      expect(app.expiresAt).toBe(901_000)
      expect(app.allowedMethods).toEqual(registration.routes[0].methods)
      expect(JSON.stringify(app)).not.toMatch(/127\.0\.0\.1|43210|ownerID|grantID/)
      expect(await category(h.send(app))).toBe("forbidden")
      h.registry.publish({ id: app.id, generation: app.generation, owner, scope })
      h.registry.publish({ id: app.id, generation: app.generation, owner, scope })
      expect(() => h.registry.publish({ id: app.id, generation: app.generation, owner, scope: { ...scope, grantID: "other" } })).toThrow("forbidden")
      app.routes[0].path = "/"
      app.allowedMethods.push("CONNECT" as never)
      expect(h.registry.list(owner)[0].routes[0].path).toBe("/app")
      expect(h.registry.list({ ...owner, ownerID: "other" })).toEqual([])
      expect(await h.send(app)).toMatchObject({ status: 200 })
    } finally { h.registry.close() }
  })

  test("validates literal hosts, ports, explicit routes, entry GET, TTL and session ownership", async () => {
    const h = harness()
    try {
      const bad = [
        { host: "localhost" }, { host: "0.0.0.0" }, { host: "::1" }, { host: "127.1" },
        { port: 0 }, { port: 65536 }, { port: 1.2 }, { port: NaN },
        { ttlMs: 0 }, { ttlMs: -1 }, { ttlMs: 3_600_001 }, { ttlMs: 0.5 },
        { routes: [] }, { routes: Array.from({ length: 65 }, () => registration.routes[0]) },
        { routes: [{ path: "*", match: "prefix", methods: ["GET"] }] },
        { routes: [{ path: "/", match: "wildcard", methods: ["GET"] }] },
        { routes: [{ path: "/app", match: "prefix", methods: [] }] },
        { routes: [{ path: "/app", match: "prefix", methods: ["CONNECT"] }] },
        { routes: [{ path: "/app?x=1", match: "prefix", methods: ["GET"] }] },
        { routes: [{ path: "/app", match: "prefix", methods: ["POST"] }] },
        { entryPath: "/outside" }, { sessionID: "other" }, { extra: "secret" },
      ]
      for (const input of bad) expect(await category(h.registry.register({ ...registration, ...input } as RemoteLocalApp.Input, owner))).toBe("invalid_registration")
      expect(await category(h.registry.register(registration, { ...owner, ownerID: "" }))).toBe("invalid_registration")
      const ipv6 = await h.add({ ...registration, host: "[::1]", port: 65535, ttlMs: 3_600_000 })
      await h.send(ipv6)
      expect(h.calls[0].url).toBe("http://[::1]:65535/app/index.html")
    } finally { h.registry.close() }
    const denied = harness({ verifySession: async () => false })
    expect(await category(denied.registry.register(registration, owner))).toBe("invalid_registration")
    denied.registry.close()
  })

  test("bounds the registry and each session, including concurrent verification reservations", async () => {
    const h = harness()
    try {
      for (let session = 0; session < 4; session++) {
        const identity = { ...owner, sessionID: `session${session}` }
        for (let i = 0; i < 16; i++) await h.add({ ...registration, sessionID: identity.sessionID }, identity)
        expect(await category(h.registry.register({ ...registration, sessionID: identity.sessionID }, identity))).toBe("busy")
      }
      expect(await category(h.registry.register(registration, owner))).toBe("busy")
      h.registry.revokeSession("session0")
      expect((await h.add()).id).toMatch(/^app_/)
    } finally { h.registry.close() }
    const gate = deferred<boolean>()
    const pending = harness({ verifySession: () => gate.promise })
    const tasks = Array.from({ length: 16 }, () => pending.registry.register(registration, owner))
    expect(await category(pending.registry.register(registration, owner))).toBe("busy")
    pending.registry.revokeSession(owner.sessionID)
    gate.resolve(true)
    expect(await Promise.all(tasks.map(category))).toEqual(Array(16).fill("not_found"))
    pending.registry.close()
  })

  test("expires deterministically, revokes only with matching ownership, and closes permanently", async () => {
    let now = 1_000
    const h = harness({ now: () => now })
    const app = await h.add({ ...registration, ttlMs: 5 })
    expect(() => h.registry.revoke({ id: app.id, owner: { ...owner, deviceID: "other" } })).toThrow("forbidden")
    now = 1_005
    expect(await category(h.send(app))).toBe("expired")
    h.registry.sweep()
    expect(h.registry.list(owner)).toEqual([])
    const second = await h.add()
    h.registry.revoke({ id: second.id, owner })
    expect(await category(h.send(second))).toBe("not_found")
    h.registry.close()
    h.registry.close()
    expect(await category(h.registry.register(registration, owner))).toBe("not_found")
  })

  test("clear aborts existing work but permits only newly registered apps afterward", async () => {
    const entered = deferred<void>()
    const h = harness({ fetcher: async () => new Response(new ReadableStream<Uint8Array>({ pull() { entered.resolve() } }, { highWaterMark: 0 })) })
    const app = await h.add()
    const running = category(h.send(app))
    await entered.promise
    h.registry.clear()
    expect(await running).toBe("upstream_unavailable")
    expect(await category(h.send(app))).toBe("not_found")
    expect(h.registry.list(owner)).toEqual([])
    expect((await h.add()).id).not.toBe(app.id)
    h.registry.close()
    const gate = deferred<boolean>()
    const pending = harness({ verifySession: () => gate.promise })
    const admission = category(pending.registry.register(registration, owner))
    pending.registry.clear()
    gate.resolve(true)
    expect(await admission).toBe("not_found")
    expect((await pending.add()).id).toMatch(/^app_/)
    pending.registry.close()
  })
})

describe("local HTTP dispatch isolation and URL validation", () => {
  test("accepts bounded OAuth client identifiers without changing their identity", async () => {
    const h = harness()
    try {
      for (const clientID of ["https://client.example/oauth", "x".repeat(2048)]) {
        const app = await h.registry.register(registration, owner)
        const identity = { ...scope, clientID }
        h.registry.publish({ id: app.id, generation: app.generation, owner, scope: identity })
        expect((await h.send(app, { scope: identity })).status).toBe(200)
      }
      for (const clientID of ["", "x".repeat(2049), "client\rvalue", "client\nvalue", "client\0value"]) {
        const app = await h.registry.register(registration, owner)
        expect(() => h.registry.publish({ id: app.id, generation: app.generation, owner, scope: { ...scope, clientID } })).toThrow("forbidden")
      }
    } finally { h.registry.close() }
  })

  test("rejects every mismatched publication field and malformed scope without contacting upstream", async () => {
    const h = harness()
    try {
      const app = await h.add()
      for (const field of Object.keys(scope)) {
        expect(await category(h.send(app, { scope: { ...scope, [field]: "other" } }))).toBe("forbidden")
        for (const value of ["", "x".repeat(field === "clientID" ? 2049 : 257), "bad\nvalue"]) {
          expect(await category(h.send(app, { scope: { ...scope, [field]: value } }))).toBe("forbidden")
        }
      }
      expect(await category(h.send(app, { generation: `generation_${"0".repeat(32)}` }))).toBe("forbidden")
      expect(await category(h.send(app, { id: `app_${"0".repeat(32)}` }))).toBe("not_found")
      expect(await category(h.send(app, { previewOrigin: "https://attacker.invalid" } as never))).toBe("forbidden")
      expect(h.calls).toEqual([])
    } finally { h.registry.close() }
  })

  test("rejects traversal, alternate authorities, ambiguous encodings and non-segment prefixes", async () => {
    const h = harness()
    try {
      const app = await h.add()
      for (const path of [
        "http://evil.invalid/app", "//evil.invalid/app", "/\\evil/app", "/app/../private", "/app/./x",
        "/app/%2e%2e/private", "/app/%252e%252e/private", "/app/%25252fprivate", "/app/%5cprivate",
        "/app/a%2Fb", "/app/%00", "/app/%250a", "/app/%", "/app/%zz", "/app/#x", "/app/\nx",
        "/app/%c0%afprivate", "/app/%25c0%25afprivate", "/app/%ed%a0%80",
        "/app-other", "/APP", "/app?x=%0d%0aInjected", "/app?x=%2500", "/app?x=%", "/app?x=#fragment",
        `/app?x=${"a".repeat(4096)}`,
      ]) expect(await category(h.send(app, { path }))).toBe("forbidden")
      expect(await category(h.send(app, { method: "CONNECT" as never }))).toBe("forbidden")
      expect(h.calls).toEqual([])
      const path = "/app/%E2%98%83?q=a%2Fb&x=%E2%98%83&x=1+2"
      await h.send(app, { path })
      expect(h.calls[0].url).toBe(`http://127.0.0.1:43210${path}`)
      const exact = await h.add({ ...registration, routes: [{ path: "/app/index.html", match: "exact", methods: ["GET"] }] })
      expect(await category(h.send(exact, { path: "/app/index.html/child" }))).toBe("forbidden")
      await h.send(exact, { path: "/app/index.html?ok=1" })
    } finally { h.registry.close() }
  })

  test("rechecks grant authorization before contact and after response without leaking denial details", async () => {
    let allowed = false
    let authorizations = 0
    const h = harness({ authorize: async (value, signal) => {
      expect(value).toEqual(scope)
      expect(signal).toBeInstanceOf(AbortSignal)
      authorizations++
      return allowed
    } })
    try {
      const app = await h.add()
      expect(await category(h.send(app))).toBe("upstream_unavailable")
      expect(h.calls).toHaveLength(0)
      allowed = true
      await h.send(app)
      expect(authorizations).toBe(3)
      expect(h.calls).toHaveLength(1)
    } finally { h.registry.close() }
    let checks = 0
    const changed = harness({ authorize: async () => ++checks === 1 })
    const app = await changed.add()
    expect(await category(changed.send(app))).toBe("upstream_unavailable")
    changed.registry.close()
    const broken = harness({ authorize: async () => { throw new Error("upstream-secret") } })
    expect(await category(broken.send(await broken.add()))).toBe("upstream_unavailable")
    broken.registry.close()
  })
})

describe("local HTTP transport policy", () => {
  test("filters credentials and hop headers, translates trusted origin/referrer, and preserves security and representation headers", async () => {
    let request: RequestInit | undefined
    const bytes = new Uint8Array([0, 255, 137, 10])
    const h = harness({
      fetcher: async (_url, init) => {
        request = init
        return new Response(bytes, { headers: {
          "content-type": "image/png", "content-length": "999", "content-encoding": "gzip",
          "cache-control": "no-cache", etag: '"v1"', "last-modified": "Wed, 01 Jan 2025 00:00:00 GMT",
          "accept-ranges": "bytes", "content-range": "bytes 0-3/4", vary: "Accept",
          "content-disposition": 'inline; filename="picture.png"',
          "content-security-policy": "default-src 'none'", "x-frame-options": "DENY",
          "set-cookie": "secret=1", "www-authenticate": "Basic secret", server: "private", "x-powered-by": "private",
          connection: "close", "x-secret": "upstream-secret",
        } })
      },
    })
    try {
      const app = await h.add()
      h.registry.publish({ id: app.id, generation: app.generation, owner, scope, previewOrigin: "https://preview.example" })
      const result = await h.send(app, { method: "POST", body: bytes, headers: {
        Accept: "image/png", "Accept-Language": "en", "Content-Type": "application/octet-stream", "If-None-Match": '"v0"',
        "If-Modified-Since": "Wed, 01 Jan 2025 00:00:00 GMT", Range: "bytes=0-3", "If-Range": '"v0"',
        Authorization: "Bearer secret", Cookie: "secret=1", Host: "evil.invalid", Forwarded: "secret",
        "X-Forwarded-For": "secret", "Proxy-Authorization": "secret", Connection: "keep-alive", "Transfer-Encoding": "chunked",
        Origin: "https://preview.example", Referer: "https://preview.example/app/index.html?q=1", "X-Secret": "secret",
      } })
      expect(request?.redirect).toBe("manual")
      expect(request?.body).toEqual(bytes)
      const headers = Object.fromEntries(new Headers(request?.headers))
      expect(headers).toEqual({
        accept: "image/png", "accept-language": "en", "content-type": "application/octet-stream", "if-none-match": '"v0"',
        "if-modified-since": "Wed, 01 Jan 2025 00:00:00 GMT", range: "bytes=0-3", "if-range": '"v0"',
        origin: "http://127.0.0.1:43210", referer: "http://127.0.0.1:43210/app/index.html?q=1", "accept-encoding": "identity",
      })
      expect(result.body).toEqual(bytes)
      expect(result.headers).toEqual({
        "content-type": "image/png", "content-length": "4", "cache-control": "no-cache", etag: '"v1"',
        "last-modified": "Wed, 01 Jan 2025 00:00:00 GMT", "accept-ranges": "bytes", "content-range": "bytes 0-3/4", vary: "Accept",
        "content-disposition": 'inline; filename="picture.png"', "content-security-policy": "default-src 'none'", "x-frame-options": "DENY",
      })
    } finally { h.registry.close() }
  })

  test("never forwards untrusted Origin/Referer and rejects WebSocket upgrades before contact", async () => {
    const h = harness()
    try {
      const app = await h.add()
      h.registry.publish({ id: app.id, generation: app.generation, owner, scope, previewOrigin: "https://preview.example" })
      const upgrades: HeadersInit[] = [{ Upgrade: "websocket" }, { Connection: "keep-alive, Upgrade" }]
      for (const headers of upgrades) {
        expect(await category(h.send(app, { headers }))).toBe("unsupported_stream")
      }
      expect(h.calls).toHaveLength(0)
      for (const referer of ["https://evil.invalid/app", "https://preview.example@evil.invalid/app", "https://preview.example/app/../secret"]) {
        await h.send(app, { headers: { Origin: "https://evil.invalid", Referer: referer } })
        expect(new Headers(h.calls.at(-1)?.init.headers).has("origin")).toBe(false)
        expect(new Headers(h.calls.at(-1)?.init.headers).has("referer")).toBe(false)
      }
    } finally { h.registry.close() }
  })

  test.each([
    [302, "GET", "next?x=%E2%98%83", "/app/next?x=%E2%98%83", true],
    [301, "POST", "/app/read", "/app/read", true],
    [302, "POST", "/app/read", "/app/read", true],
    [303, "PUT", "/app/read", "/app/read", true],
    [303, "HEAD", "/app/read", "/app/read", true],
    [307, "POST", "/app/read", "", false],
    [308, "POST", "/app/read", "", false],
    [307, "POST", "/app/write", "/app/write", true],
    [302, "GET", "http://127.0.0.1:43210/app/read", "/app/read", true],
    [302, "GET", "//127.0.0.1:43210/app/read", "", false],
    [302, "GET", "http://127.0.0.1:43211/app/read", "", false],
    [302, "GET", "http://localhost:43210/app/read", "", false],
    [302, "GET", "http://0x7f000001:43210/app/read", "", false],
    [302, "GET", "https://evil.invalid/app", "", false],
    [302, "GET", "http://secret@127.0.0.1:43210/app/read", "", false],
    [302, "GET", "/private", "", false],
    [302, "GET", "/app/%252e%252e/private", "", false],
    [302, "GET", "../private", "", false],
    [302, "GET", "/app/read#secret", "", false],
  ] as const)("validates redirect %s %s %s without following", async (status, method, location, expected, allowed) => {
    let calls = 0
    const h = harness({ fetcher: async () => { calls++; return new Response(null, { status, headers: { location } }) } })
    try {
      const app = await h.add({ ...registration, routes: [
        { path: "/app/index.html", match: "exact", methods: ["GET", "HEAD", "POST", "PUT"] },
        { path: "/app/read", match: "exact", methods: ["GET", "HEAD"] },
        { path: "/app/next", match: "exact", methods: ["GET"] },
        { path: "/app/write", match: "exact", methods: ["POST"] },
      ] })
      const result = h.send(app, { method })
      if (allowed) expect(await result).toMatchObject({ status, headers: { location: expected } })
      else expect(await category(result)).toBe("redirect_rejected")
      expect(calls).toBe(1)
    } finally { h.registry.close() }
  })

  test("caps request bytes and both declared and growing response bodies; cancels event streams", async () => {
    const h = harness()
    try {
      const app = await h.add()
      await h.send(app, { method: "POST", body: new Uint8Array(262_144) })
      expect(await category(h.send(app, { method: "POST", body: new Uint8Array(262_145) }))).toBe("too_large")
      expect(h.calls).toHaveLength(1)
    } finally { h.registry.close() }
    for (const mode of ["declared", "growth", "event"] as const) {
      let cancelled = false
      let emitted = false
      const fixture = harness({ fetcher: async () => new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          if (emitted) return
          emitted = true
          controller.enqueue(new Uint8Array(mode === "growth" ? 2_097_153 : 1))
        },
        cancel() { cancelled = true },
      }), { headers: mode === "declared" ? { "content-length": "2097153" } : mode === "event" ? { "content-type": "Text/Event-Stream; charset=utf-8" } : {} }) })
      try {
        expect(await category(fixture.send(await fixture.add()))).toBe(mode === "event" ? "unsupported_stream" : "too_large")
        expect(cancelled).toBe(true)
      } finally { fixture.registry.close() }
    }
    const maximum = harness({ fetcher: async () => new Response(new Uint8Array(2_097_152)) })
    expect((await maximum.send(await maximum.add())).body.byteLength).toBe(2_097_152)
    maximum.registry.close()
  })

  test("allows at most four requests per app and sixteen total with no queued retries", async () => {
    const entered = deferred<void>()
    const release = deferred<void>()
    let calls = 0
    const h = harness({ fetcher: async () => {
      if (++calls === 16) entered.resolve()
      await release.promise
      return new Response("ok")
    } })
    try {
      const apps = await Promise.all(Array.from({ length: 5 }, () => h.add()))
      const running = apps.slice(0, 4).flatMap((app) => Array.from({ length: 4 }, () => h.send(app)))
      await entered.promise
      expect(await category(h.send(apps[0]))).toBe("busy")
      expect(await category(h.send(apps[4]))).toBe("busy")
      expect(calls).toBe(16)
      release.resolve()
      await Promise.all(running)
      expect((await h.send(apps[4])).status).toBe(200)
    } finally { release.resolve(); h.registry.close() }
  })

  test.each(["revoke", "session", "close", "expiry", "caller"] as const)("%s aborts an in-flight body and suppresses its result", async (action) => {
    const entered = deferred<void>()
    let cancelled = false
    let signal: AbortSignal | undefined
    let now = 1_000
    const caller = new AbortController()
    const h = harness({ now: () => now, fetcher: async (_url, init) => {
      signal = init?.signal ?? undefined
      return new Response(new ReadableStream<Uint8Array>({ pull() { entered.resolve() }, cancel() { cancelled = true } }, { highWaterMark: 0 }))
    } })
    const app = await h.add({ ...registration, ttlMs: 100 })
    const result = category(h.send(app, { signal: caller.signal }))
    await entered.promise
    if (action === "revoke") h.registry.revoke({ id: app.id, owner })
    if (action === "session") h.registry.revokeSession(owner.sessionID)
    if (action === "close") h.registry.close()
    if (action === "expiry") { now += 100; h.registry.sweep() }
    if (action === "caller") caller.abort()
    expect(await result).toBe("upstream_unavailable")
    expect(signal?.aborted).toBe(true)
    expect(cancelled).toBe(true)
    h.registry.close()
  })

  test("cancellation bounds non-cooperative authorization and transport failures stay sanitized", async () => {
    const entered = deferred<void>()
    const h = harness({ authorize: async () => { entered.resolve(); return new Promise<boolean>(() => {}) } })
    const app = await h.add()
    const result = category(h.send(app))
    await entered.promise
    h.registry.close()
    expect(await result).toBe("upstream_unavailable")
    const failure = harness({ fetcher: async () => { throw new Error("upstream-secret http://127.0.0.1:43210") } })
    expect(await category(failure.send(await failure.add()))).toBe("upstream_unavailable")
    failure.registry.close()
    const controller = new AbortController()
    controller.abort()
    const cancelled = harness()
    expect(await category(cancelled.send(await cancelled.add(), { signal: controller.signal }))).toBe("upstream_unavailable")
    expect(cancelled.calls).toHaveLength(0)
    cancelled.registry.close()
  })

  test("transport stalls, response read errors, and post-response authorization stalls are cancellable", async () => {
    for (const phase of ["fetch", "read", "authorize"] as const) {
      const entered = deferred<void>()
      let checks = 0
      const h = harness({
        authorize: async () => {
          if (phase === "authorize" && ++checks === 2) { entered.resolve(); return new Promise<boolean>(() => {}) }
          return true
        },
        fetcher: async () => {
          if (phase === "fetch") { entered.resolve(); return new Promise<Response>(() => {}) }
          if (phase === "read") return new Response(new ReadableStream({ start(controller) { entered.resolve(); controller.error(new Error("upstream-secret")) } }))
          return new Response("ok")
        },
      })
      const result = category(h.send(await h.add()))
      await entered.promise
      if (phase !== "read") h.registry.close()
      expect(await result).toBe("upstream_unavailable")
      h.registry.close()
    }
  })
})
