import { expect, test } from "bun:test"
import { createServer, type IncomingHttpHeaders, type Server } from "node:http"
import { previewHarness, previewOrigins } from "../test/remote-app-preview-harness"

const listen = (server: Server) => new Promise<number>((resolve, reject) => {
  server.once("error", reject)
  server.listen(0, "127.0.0.1", () => {
    const address = server.address()
    if (address === null || typeof address === "string") reject(new Error("missing fixture address"))
    else resolve(address.port)
  })
})
const close = (server: Server) => new Promise<void>((resolve, reject) => {
  server.closeAllConnections()
  server.close((error) => error ? reject(error) : resolve())
})

test("a browser reaches only the registered loopback app through the Worker, relay, connector and gateway", async () => {
  const requests: Array<{ path: string; method: string; headers: IncomingHttpHeaders }> = []
  let forbiddenHits = 0
  const forbidden = createServer((_request, response) => { forbiddenHits++; response.end("forbidden") })
  const app = createServer((request, response) => {
    requests.push({ path: request.url ?? "", method: request.method ?? "", headers: request.headers })
    const path = request.url?.split("?")[0]
    response.setHeader("set-cookie", "app_session=synthetic-secret")
    response.setHeader("x-powered-by", "fixture")
    if (path === "/index.html") { response.setHeader("content-type", "text/html"); response.end('<!doctype html><script src="app.js"></script><a href="sub/page.html">Next</a>'); return }
    if (path === "/sub/page.html") { response.setHeader("content-type", "text/html"); response.end('<!doctype html><a href="../index.html">Back</a><img src="../app.js">'); return }
    if (path === "/absolute.html") { response.setHeader("content-type", "text/html"); response.end('<!doctype html><script src="/app.js"></script>'); return }
    if (path === "/app.js") {
      const body = "document.body.dataset.ready = 'true'"
      response.writeHead(200, { "content-type": "text/javascript", "content-length": Buffer.byteLength(body) })
      response.end(request.method === "HEAD" ? undefined : body)
      return
    }
    if (path === "/api/value") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ query: request.url?.split("?")[1] ?? "" })); return }
    if (path === "/big") { response.setHeader("content-type", "application/octet-stream"); response.end(Buffer.alloc(1_572_864, 7)); return }
    response.writeHead(404)
    response.end("missing")
  })
  const forbiddenPort = await listen(forbidden)
  const port = await listen(app)
  const h = previewHarness({ appPreview: { origins: previewOrigins, ports: [port], frameAncestors: ["https://chat.example.invalid"] } })
  try {
    await h.connect()
    const registered = (await h.call("local_app_register", { host: "127.0.0.1", port, entryPath: "/index.html", routes: [{ path: "/", match: "prefix", methods: ["GET", "HEAD"] }] })).structuredContent
    const opened = await h.call("local_app_open", { id: registered.id, generation: registered.generation })
    expect(opened.structuredContent).toMatchObject({ status: "ready" })
    const bootstrapURL = opened._meta!.localApp!.url
    const previewOrigin = new URL(bootstrapURL).origin
    expect(previewOrigin).toBe(previewOrigins[0])

    const bootstrap = await h.worker(new Request(bootstrapURL))
    expect(bootstrap.status).toBe(303)
    const location = bootstrap.headers.get("location")!
    expect(location).toMatch(/^\/_r\/[a-f0-9]{16}\/index\.html$/)
    const base = `${previewOrigin}${location.slice(0, -"/index.html".length)}`
    const cookie = bootstrap.headers.get("set-cookie")!.split(";")[0]!
    expect(cookie).toMatch(/^__Host-ycoding-preview=[A-Za-z0-9_-]{43}$/)
    expect(requests).toEqual([])
    const relayedAfterBootstrap = h.relayed.length
    expect((await h.worker(new Request(bootstrapURL))).status).toBe(401)
    expect(h.relayed.length).toBe(relayedAfterBootstrap)

    const browser = { cookie: `theme=dark; ${cookie}`, authorization: "Bearer synthetic", accept: "text/html" }
    const entry = new URL(location, previewOrigin)
    const page = await h.worker(new Request(entry.toString(), { headers: browser }))
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('src="app.js"')
    expect(page.headers.get("set-cookie")).toBeNull()
    expect(page.headers.get("x-powered-by")).toBeNull()
    expect(page.headers.get("cache-control")).toBe("no-store, no-transform")
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors https://chat.example.invalid")
    const script = await h.worker(new Request(new URL("app.js", entry).toString(), { headers: browser }))
    expect(await script.text()).toContain("dataset.ready")
    const next = new URL("sub/page.html", entry)
    expect(next.toString()).toBe(`${base}/sub/page.html`)
    const subpage = await h.worker(new Request(next.toString(), { headers: browser }))
    expect(await subpage.text()).toContain('href="../index.html"')
    const back = new URL("../index.html", next)
    expect(back.toString()).toBe(entry.toString())
    expect((await h.worker(new Request(back.toString(), { headers: browser }))).status).toBe(200)
    expect((await h.worker(new Request(new URL("../app.js", next).toString(), { headers: browser }))).status).toBe(200)
    const api = await h.worker(new Request(`${base}/api/value?x=1&y=%E2%98%83`, { headers: browser }))
    expect(await api.json()).toEqual({ query: "x=1&y=%E2%98%83" })
    const head = await h.worker(new Request(`${base}/app.js`, { method: "HEAD", headers: browser }))
    expect(head.status).toBe(200)
    expect(head.headers.get("content-length")).toBe(String("document.body.dataset.ready = 'true'".length))
    const absolute = await h.worker(new Request(`${base}/absolute.html`, { headers: browser }))
    expect(await absolute.text()).toContain('src="/app.js"')
    expect((await h.worker(new Request(new URL("/app.js", `${base}/absolute.html`).toString(), { headers: browser }))).status).toBe(404)
    expect(requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      "GET /index.html", "GET /app.js", "GET /sub/page.html", "GET /index.html", "GET /app.js", "GET /api/value?x=1&y=%E2%98%83", "HEAD /app.js", "GET /absolute.html",
    ])
    expect(requests.every((request) => request.headers.cookie === undefined && request.headers.authorization === undefined)).toBe(true)

    const before = requests.length
    for (const path of ["/index.html", "/a%2fb", "/a%5cb", "/%252e%252e/index.html", "//127.0.0.1:1/x", `//127.0.0.1:${forbiddenPort}/x`])
      expect((await h.worker(new Request(`${previewOrigin}${path}`, { headers: browser }))).status).toBe(404)
    for (const path of ["/a%2fb", "/a%5cb", "/%252e%252e/index.html", `//127.0.0.1:${forbiddenPort}/x`])
      expect((await h.worker(new Request(`${base}${path}`, { headers: browser }))).status).toBe(404)
    for (const method of ["POST", "PUT", "DELETE", "OPTIONS"])
      expect((await h.worker(new Request(`${base}/api/value`, { method, headers: browser }))).status).toBe(405)
    expect((await h.worker(new Request(`${base}/index.html`, { headers: { ...browser, upgrade: "websocket", connection: "Upgrade" } }))).status).toBe(426)
    const device = { ownerID: "owner_fixture", deviceID: "device_fixture" }
    const prefix = new URL(base).pathname
    for (const path of [`${prefix}//127.0.0.1:${forbiddenPort}/x`, `${prefix}/%2f%2f127.0.0.1:${forbiddenPort}/x`, `${prefix}/%2e%2e/%2e%2e/etc/passwd`, `${prefix}/..%5c..%5cetc/passwd`, `${prefix}/a/../../x`,
      `//127.0.0.1:${forbiddenPort}/x`, "/index.html", `/_r/${"0".repeat(16)}/index.html`])
      expect([404, 410]).toContain((await h.relay.request({ ...device, input: { origin: previewOrigin, method: "GET", path, headers: { cookie } } })).status)
    expect((await h.relay.request({ ...device, input: { origin: previewOrigin, method: "GET", path: "/_ycoding/bootstrap", headers: { cookie } } })).status).toBe(401)
    expect((await h.relay.request({ ...device, input: { origin: previewOrigins[1]!, method: "GET", path: `${prefix}/index.html`, headers: { cookie } } })).status).toBe(404)
    await expect(h.relay.request({ ...device, input: { origin: previewOrigin, method: "GET", path: `http://127.0.0.1:${forbiddenPort}/x`, headers: { cookie } } })).rejects.toMatchObject({ status: 400 })
    await expect(h.relay.request({ ...device, input: { origin: previewOrigin, method: "POST" as "GET", path: `${prefix}/api/value`, headers: { cookie } } })).rejects.toMatchObject({ status: 400 })
    await expect(h.relay.request({ ...device, input: { origin: "https://other.example.invalid", method: "GET", path: `${prefix}/index.html`, headers: { cookie } } })).rejects.toMatchObject({ status: 403 })
    expect(requests.length).toBe(before)
    const authority = await h.relay.request({ ...device, input: { origin: previewOrigin, method: "GET", path: `${prefix}/@127.0.0.1:${forbiddenPort}/x`, headers: { cookie } } })
    expect(authority.status).toBe(404)
    expect(requests.at(-1)!.path).toBe(`/@127.0.0.1:${forbiddenPort}/x`)
    expect(forbiddenHits).toBe(0)

    expect((await h.worker(new Request(`${base}/big`, { headers: browser }))).status).toBe(502)

    await h.call("local_app_revoke", { id: registered.id })
    const relayedBeforeRevocation = h.relayed.length
    const afterRevoke = await h.worker(new Request(`${base}/index.html`, { headers: browser }))
    expect(afterRevoke.status).toBe(410)
    expect(h.relayed.length).toBe(relayedBeforeRevocation)
    expect(forbiddenHits).toBe(0)
  } finally {
    await h.bridge.close()
    await close(app)
    await close(forbidden)
  }
})

test("a revoked grant stops preview requests before the loopback app is contacted", async () => {
  let hits = 0
  const app = createServer((_request, response) => { hits++; response.setHeader("content-type", "text/html"); response.end("<p>fixture</p>") })
  const port = await listen(app)
  const h = previewHarness({ appPreview: { origins: previewOrigins, ports: [port], frameAncestors: [] } })
  try {
    await h.connect()
    const registered = (await h.call("local_app_register", { host: "127.0.0.1", port, entryPath: "/", routes: [{ path: "/", match: "exact", methods: ["GET"] }] })).structuredContent
    const opened = await h.call("local_app_open", { id: registered.id, generation: registered.generation })
    const url = new URL(opened._meta!.localApp!.url)
    const bootstrap = await h.worker(new Request(url.toString()))
    const cookie = bootstrap.headers.get("set-cookie")!.split(";")[0]!
    const entry = new URL(bootstrap.headers.get("location")!, url.origin)
    expect((await h.worker(new Request(entry.toString(), { headers: { cookie } }))).status).toBe(200)
    expect(hits).toBe(1)
    expect((await h.worker(new Request(new URL("other", entry).toString(), { headers: { cookie } }))).status).toBe(502)
    h.deny()
    expect((await h.worker(new Request(entry.toString(), { headers: { cookie } }))).status).toBe(403)
    expect(hits).toBe(1)
  } finally {
    await h.bridge.close()
    await close(app)
  }
})
