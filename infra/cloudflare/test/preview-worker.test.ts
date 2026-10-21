import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { RemoteAppPreview, sha256Hex, type PreviewInput, type PreviewResult } from "../../../packages/remote/src/index"
import { createPreviewDirectoryStore } from "../src/preview/directory-store"
import { createPreviewWorker } from "../src/preview/worker"

const pool = ["https://preview-1.example.invalid", "https://preview-2.example.invalid", "https://preview-3.example.invalid"]
const devices = {
  device_a: { ownerID: "owner_a", deviceID: "device_a" },
  device_b: { ownerID: "owner_b", deviceID: "device_b" },
} as const
type DeviceID = keyof typeof devices
const scope = (deviceID: DeviceID) => ({ ...devices[deviceID], sessionID: "ses_fixture", clientID: "client_fixture", grantID: "grant_fixture", epoch: "epoch_fixture" })
const app = (character: string) => ({ id: `app_${character.repeat(32)}`, generation: `generation_${character.repeat(32)}` })
const cleanup: Array<() => void> = []
afterEach(() => { for (const close of cleanup.splice(0)) close() })

type Answer = (input: RemoteAppPreview.DispatchInput) => RemoteAppPreview.DispatchResult

function fixture(options: { origins?: readonly string[]; answer?: Answer; device?: (input: PreviewInput) => Response | undefined } = {}) {
  const clock = { time: 1_000_000 }
  const database = new Database(":memory:")
  const store = createPreviewDirectoryStore({
    sql: { exec: (query, ...bindings) => ({ toArray: () => database.prepare(query).all(...(bindings as never[])) }) },
    transactionSync: (operation) => database.transaction(operation)(),
  }, () => clock.time)
  const dispatched: Array<{ deviceID: DeviceID; id: string; path: string; headers: Record<string, string> }> = []
  const forwarded: Array<{ deviceID: string; input: PreviewInput }> = []
  const directoryCalls: string[] = []
  const gateways = Object.fromEntries((Object.keys(devices) as DeviceID[]).map((deviceID) => {
    const gateway = RemoteAppPreview.create({
      origins: pool, frameAncestors: ["https://chat.example.invalid"], now: () => clock.time,
      authorize: async () => true,
      dispatch: async (input) => {
        dispatched.push({ deviceID, id: input.id, path: input.path, headers: input.headers })
        return options.answer?.(input) ?? { status: 200, headers: { "content-type": "text/html", "set-cookie": "app=secret", server: "fixture" }, body: new TextEncoder().encode(`${deviceID}:${input.id.slice(4, 5)}:${input.path}`) }
      },
    })
    cleanup.push(() => gateway.close())
    return [deviceID, gateway]
  })) as Record<DeviceID, ReturnType<typeof RemoteAppPreview.create>>
  const worker = createPreviewWorker({
    origins: options.origins ?? pool,
    directory: {
      redeem: async (ticketHash, origin) => { directoryCalls.push("redeem"); return store.redeem(ticketHash, origin) },
      bind: async (input) => { directoryCalls.push("bind"); return store.bind(input) },
      resolve: async (cookieHash, leaseTag, origin) => { directoryCalls.push("resolve"); return store.resolve(cookieHash, leaseTag, origin) },
    },
    forward: async (device, input) => {
      forwarded.push({ deviceID: device.deviceID, input })
      const custom = options.device?.(input)
      if (custom !== undefined) return custom
      const response = await gateways[device.deviceID as DeviceID].fetch(new Request(`${input.origin}${input.path}`, { method: input.method, headers: input.headers }))
      const result: PreviewResult = {
        status: response.status,
        headers: [...[...response.headers].filter(([name]) => name !== "set-cookie"), ...response.headers.getSetCookie().map((value) => ["set-cookie", value] as const)],
        body: Buffer.from(await response.arrayBuffer()).toString("base64"),
      }
      return Response.json(result)
    },
  })
  const lease = async (deviceID: DeviceID = "device_a", character = "a") => {
    const target = app(character)
    const registration = await sha256Hex(`${target.id}:${target.generation}`)
    const allocation = store.allocate({ ...devices[deviceID], registration, expiresAt: clock.time + 3_600_000, origins: pool })
    if (allocation.state !== "allocated") throw new Error(`allocation ${allocation.state}`)
    const issued = await gateways[deviceID].issue({ ...target, scope: scope(deviceID), origin: allocation.origin, entryPath: "/index.html", expiresAt: clock.time + 60_000 })
    const ticketHash = await sha256Hex(new URL(issued.url).searchParams.get("ticket")!)
    expect(store.register({ ...devices[deviceID], origin: issued.origin, registration, ticketHash, leaseTag: issued.tag, expiresAt: issued.expiresAt })).toBe(true)
    return { ...issued, ticketHash, registration, base: `${issued.origin}/_r/${issued.tag}` }
  }
  const open = async (deviceID: DeviceID = "device_a", character = "a") => {
    const issued = await lease(deviceID, character)
    const response = await f(new Request(issued.url))
    return { ...issued, response, cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "" }
  }
  const f = worker
  const count = (deviceID: DeviceID, character: string) => dispatched.filter((entry) => entry.deviceID === deviceID && entry.id === app(character).id).length
  return { worker, store, lease, open, gateways, dispatched, forwarded, directoryCalls, count, advance: (ms: number) => { clock.time += ms } }
}

test("preview is disabled with an empty origin list and serves only listed origins", async () => {
  const f = fixture({ origins: [] })
  const issued = await f.lease()
  expect((await f.worker(new Request(issued.url))).status).toBe(404)
  expect((await f.worker(new Request(`${issued.base}/index.html`))).status).toBe(404)
  expect(f.directoryCalls).toEqual([])
  const g = fixture({ origins: [pool[1]!] })
  const other = await g.lease()
  expect(other.origin).toBe(pool[0])
  expect((await g.worker(new Request(other.url))).status).toBe(404)
  expect(g.directoryCalls).toEqual([])
  expect(g.forwarded).toEqual([])
})

test("only GET and HEAD without upgrades or bodies are accepted before any lookup", async () => {
  const f = fixture()
  const issued = await f.lease()
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    const response = await f.worker(new Request(issued.url, { method }))
    expect(response.status).toBe(405)
    expect(response.headers.get("allow")).toBe("GET, HEAD")
  }
  expect((await f.worker(new Request(issued.url, { headers: { upgrade: "websocket", connection: "Upgrade" } }))).status).toBe(426)
  expect((await f.worker(new Request(issued.url, { headers: { connection: "keep-alive, upgrade" } }))).status).toBe(426)
  expect((await f.worker(new Request(issued.url, { headers: { "content-length": String(RemoteAppPreview.maxRequestBytes + 1) } }))).status).toBe(413)
  expect((await f.worker(new Request(issued.url, { headers: { accept: "x".repeat(2049) } }))).status).toBe(431)
  expect((await f.worker(new Request(issued.url, { method: "HEAD" }))).status).toBe(405)
  expect(f.directoryCalls).toEqual([])
  expect(f.forwarded).toEqual([])
})

test("a single-use bootstrap redirects into the lease prefix and binds its cookie to that lease", async () => {
  const f = fixture()
  const opened = await f.open()
  expect(opened.response.status).toBe(303)
  expect(opened.response.headers.get("location")).toBe(`/_r/${opened.tag}/index.html`)
  expect(opened.response.headers.get("set-cookie")).toMatch(/^__Host-ycoding-preview=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=None; Partitioned; Max-Age=60$/)
  expect(opened.response.headers.get("cache-control")).toBe("no-store, no-transform")
  expect(opened.response.headers.has("clear-site-data")).toBe(false)
  const forwardedCount = f.forwarded.length
  expect((await f.worker(new Request(opened.url))).status).toBe(401)
  expect(f.forwarded.length).toBe(forwardedCount)
  const page = await f.worker(new Request(`${opened.base}/index.html`, { headers: { cookie: opened.cookie } }))
  expect(page.status).toBe(200)
  expect(await page.text()).toBe("device_a:a:/index.html")
  const lookups = f.directoryCalls.length
  for (const url of [`${opened.origin}/index.html`, `${opened.origin}/_r/${opened.tag}`, `${opened.origin}/_r/${opened.tag.toUpperCase()}/index.html`, `${opened.origin}/_r/short/index.html`])
    expect((await f.worker(new Request(url, { headers: { cookie: opened.cookie } }))).status).toBe(404)
  expect(f.directoryCalls.length).toBe(lookups)
  expect(f.count("device_a", "a")).toBe(1)
})

test("two registrations receive different origins, and a burned origin is never served again", async () => {
  const f = fixture()
  const a = await f.open("device_a", "a")
  const b = await f.open("device_b", "b")
  expect(a.origin).not.toBe(b.origin)
  f.store.revoke({ ...devices.device_a, registration: a.registration })
  const c = await f.open("device_a", "c")
  expect(c.origin).toBe(pool[2])
  expect(new Set([a.origin, b.origin, c.origin]).size).toBe(3)
  await expect(f.lease("device_b", "d")).rejects.toThrow("allocation exhausted")
  for (const request of [new Request(`${a.base}/index.html`, { headers: { cookie: a.cookie } }), new Request(`${a.origin}/_r/${c.tag}/index.html`, { headers: { cookie: c.cookie } })])
    expect((await f.worker(request)).status).toBe(410)
  expect(f.count("device_a", "a")).toBe(0)
  expect(f.count("device_a", "c")).toBe(0)
})

test("misrouting rejection: an old preview path or cookie never reaches a newer preview's app", async () => {
  for (const end of ["revoke", "expire"] as const) {
    const f = fixture()
    const a = await f.open("device_a", "a")
    expect((await f.worker(new Request(`${a.base}/index.html`, { headers: { cookie: a.cookie } }))).status).toBe(200)
    if (end === "revoke") f.store.revoke({ ...devices.device_a, registration: a.registration })
    else f.advance(3_600_000)
    const b = await f.open("device_a", "b")
    expect(b.response.status).toBe(303)
    expect(b.origin).not.toBe(a.origin)
    const jar = b.cookie
    const attempts = [
      new Request(`${a.base}/index.html`, { headers: { cookie: jar } }),
      new Request(`${b.origin}/_r/${a.tag}/index.html`, { headers: { cookie: jar } }),
      new Request(`${a.base}/index.html`, { headers: { cookie: a.cookie } }),
      new Request(`${b.origin}/_r/${a.tag}/index.html`, { headers: { cookie: a.cookie } }),
      new Request(`${b.base}/index.html`, { headers: { cookie: a.cookie } }),
      new Request(`${b.base}/index.html`, { headers: { cookie: `${a.cookie}; ${jar}` } }),
    ]
    const statuses = []
    for (const request of attempts) statuses.push((await f.worker(request)).status)
    expect(statuses.every((status) => [401, 409, 410].includes(status))).toBe(true)
    expect(f.count("device_a", "b")).toBe(0)
    expect((await f.worker(new Request(`${b.base}/index.html`, { headers: { cookie: jar } }))).status).toBe(200)
    expect(f.count("device_a", "b")).toBe(1)
  }
})

test("misrouting rejection on one origin: a reopened lease kills the previous path tag", async () => {
  const f = fixture()
  const first = await f.open()
  const second = await f.open()
  expect(second.origin).toBe(first.origin)
  expect(second.tag).not.toBe(first.tag)
  expect((await f.worker(new Request(`${first.base}/index.html`, { headers: { cookie: second.cookie } }))).status).toBe(409)
  expect((await f.worker(new Request(`${second.base}/index.html`, { headers: { cookie: first.cookie } }))).status).toBe(409)
  f.store.revoke({ ...devices.device_a, ticketHash: first.ticketHash })
  expect((await f.worker(new Request(`${first.base}/index.html`, { headers: { cookie: second.cookie } }))).status).toBe(410)
  expect((await f.worker(new Request(`${second.base}/index.html`, { headers: { cookie: first.cookie } }))).status).toBe(401)
  expect(f.count("device_a", "a")).toBe(0)
  expect((await f.worker(new Request(`${second.base}/index.html`, { headers: { cookie: second.cookie } }))).status).toBe(200)
})

test("unknown, forged, malformed, duplicate, expired and ended credentials are answered without contacting a device", async () => {
  const f = fixture()
  const issued = await f.lease()
  const forged = `${issued.origin}/_ycoding/bootstrap?ticket=${"x".repeat(43)}`
  expect((await f.worker(new Request(forged))).status).toBe(401)
  for (const url of [`${issued.origin}/_ycoding/bootstrap?ticket=short`, `${issued.origin}/_ycoding/bootstrap`, `${forged}&next=/`, `${issued.origin}/_ycoding/bootstrap?ticket=${"x".repeat(43)}&ticket=${"y".repeat(43)}`])
    expect((await f.worker(new Request(url))).status).toBe(401)
  expect((await f.worker(new Request(`${pool[2]}/_ycoding/bootstrap?ticket=${new URL(issued.url).searchParams.get("ticket")}`))).status).toBe(404)
  for (const cookie of [undefined, `__Host-ycoding-preview=${"z".repeat(43)}`, "__Host-ycoding-preview=short", `__Host-ycoding-preview=${"z".repeat(43)}; __Host-ycoding-preview=${"y".repeat(43)}`, "session=other"])
    expect((await f.worker(new Request(`${issued.base}/index.html`, cookie === undefined ? {} : { headers: { cookie } }))).status).toBe(401)
  expect(f.forwarded).toEqual([])
  const opened = await f.open("device_a")
  const count = f.forwarded.length
  f.advance(60_000)
  expect((await f.worker(new Request(`${opened.base}/index.html`, { headers: { cookie: opened.cookie } }))).status).toBe(410)
  const unredeemed = await f.lease("device_b", "b")
  f.store.revoke({ ...devices.device_b, registration: unredeemed.registration })
  expect((await f.worker(new Request(unredeemed.url))).status).toBe(410)
  expect((await f.worker(new Request(`${pool[2]}/_r/${opened.tag}/index.html`, { headers: { cookie: opened.cookie } }))).status).toBe(404)
  expect(f.forwarded.length).toBe(count)
})

test("only allowlisted headers cross the Worker in either direction", async () => {
  const f = fixture()
  const opened = await f.open()
  const page = await f.worker(new Request(`${opened.base}/index.html?view=1`, { headers: {
    cookie: `theme=dark; ${opened.cookie}; other=1`, authorization: "Bearer synthetic", "x-forwarded-for": "203.0.113.1", accept: "text/html", origin: opened.origin, referer: `${opened.base}/index.html`,
  } }))
  expect(page.status).toBe(200)
  expect(f.forwarded.at(-1)!.input).toEqual({ origin: opened.origin, method: "GET", path: `/_r/${opened.tag}/index.html?view=1`,
    headers: { accept: "text/html", origin: opened.origin, referer: `${opened.base}/index.html`, cookie: opened.cookie } })
  expect(f.dispatched.at(-1)!.headers).toEqual({ accept: "text/html", origin: opened.origin, referer: `${opened.origin}/index.html` })
  expect(f.dispatched.at(-1)!.path).toBe("/index.html?view=1")
  expect(page.headers.get("set-cookie")).toBeNull()
  expect(page.headers.get("server")).toBeNull()
  expect(page.headers.get("cache-control")).toBe("no-store, no-transform")
  expect(page.headers.get("content-security-policy")).toContain("worker-src 'none'")
  expect(page.headers.get("x-content-type-options")).toBe("nosniff")
})

test("traversal and encoded separators never leave the lease prefix", async () => {
  const f = fixture()
  const opened = await f.open()
  const count = f.forwarded.length
  for (const path of ["/a%2fb", "/a%5cb", "/%252e%252e/secret", "//127.0.0.1:22/x", "/_ycoding/other", "/../index.html", "/%2e%2e/index.html"])
    expect((await f.worker(new Request(`${opened.base}${path}`, { headers: { cookie: opened.cookie } }))).status).toBe(404)
  expect(f.forwarded.length).toBe(count)
  for (const path of ["/app/../secret", "/app/%2e%2e/secret"]) {
    expect((await f.worker(new Request(`${opened.base}${path}`, { headers: { cookie: opened.cookie } }))).status).toBe(200)
    expect(f.dispatched.at(-1)!.path).toBe("/secret")
  }
})

test("device responses are bounded and a bootstrap needs one valid cookie and the lease prefix", async () => {
  const exact = fixture({ answer: () => ({ status: 200, headers: {}, body: new Uint8Array(RemoteAppPreview.maxResponseBytes) }) })
  const opened = await exact.open()
  expect((await exact.worker(new Request(`${opened.base}/index.html`, { headers: { cookie: opened.cookie } }))).status).toBe(200)
  const limit = fixture({ device: (input) => input.path.endsWith("/big") ? Response.json({ status: 200, headers: [], body: Buffer.alloc(RemoteAppPreview.maxResponseBytes + 1).toString("base64") }) : undefined })
  const bounded = await limit.open()
  expect((await limit.worker(new Request(`${bounded.base}/big`, { headers: { cookie: bounded.cookie } }))).status).toBe(502)
  for (const headers of [[["location", "/index.html"], ["set-cookie", `__Host-ycoding-preview=${"c".repeat(43)}; Path=/`]], [["location", "/_r/0000000000000000/index.html"], ["set-cookie", `__Host-ycoding-preview=${"c".repeat(43)}; Path=/`]]]) {
    const wrong = fixture({ device: (input) => input.path.startsWith("/_ycoding/") ? Response.json({ status: 303, headers, body: "" }) : undefined })
    const refused = await wrong.open()
    expect(refused.response.status).toBe(502)
    expect(refused.response.headers.get("set-cookie")).toBeNull()
  }
  const missing = fixture({ device: (input) => input.path.startsWith("/_ycoding/") ? Response.json({ status: 303, headers: [["location", "/"]], body: "" }) : undefined })
  expect((await missing.open()).response.status).toBe(502)
  const unavailable = fixture({ device: () => new Response("busy", { status: 503 }) })
  expect((await unavailable.open()).response.status).toBe(503)
})

test("HEAD keeps the representation length without a body", async () => {
  const f = fixture()
  const opened = await f.open()
  const response = await f.worker(new Request(`${opened.base}/index.html`, { method: "HEAD", headers: { cookie: opened.cookie } }))
  expect(response.status).toBe(200)
  expect(response.headers.get("content-length")).toBe(String("device_a:a:/index.html".length))
  expect(await response.text()).toBe("")
})
