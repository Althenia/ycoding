import { expect, test } from "bun:test"
import { createServer } from "node:http"
import { gzipSync } from "node:zlib"
import { RemoteLocalApp } from "../src/remote-local-app"

test("synthetic loopback preserves pages, relative assets, APIs, statuses, ranges and safe redirects", async () => {
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 1])
  const html = '<!doctype html><link rel="stylesheet" href="style.css"><script src="/app/app.js"></script><img src="image.png"><a href="/app/api">API</a>'
  const requests: { path: string; headers: Record<string, string | string[] | undefined> }[] = []
  let forbiddenHits = 0
  const forbidden = createServer((_req, res) => { forbiddenHits++; res.end("forbidden") })
  const server = createServer(async (req, res) => {
    requests.push({ path: req.url ?? "", headers: req.headers })
    const path = req.url?.split("?")[0]
    if (path === "/app/index.html") { res.setHeader("content-type", "text/html"); res.setHeader("content-security-policy", "default-src 'self'"); res.end(html); return }
    if (path === "/app/style.css") { res.setHeader("content-type", "text/css"); res.end("body{color:navy}"); return }
    if (path === "/app/app.js") { res.setHeader("content-type", "text/javascript"); res.end('fetch("./api")'); return }
    if (path === "/app/image.png") { res.setHeader("content-type", "image/png"); res.end(png); return }
    if (path === "/app/compressed") { res.setHeader("content-encoding", "gzip"); res.end(gzipSync("decoded bytes")); return }
    if (path === "/app/empty") { res.writeHead(204); res.end(); return }
    if (path === "/app/cached") { res.writeHead(304, { etag: '"v1"' }); res.end(); return }
    if (path === "/app/error") { res.writeHead(422, { "content-type": "application/json" }); res.end('{"error":"invalid"}'); return }
    if (path === "/app/range") { res.writeHead(206, { "content-range": "bytes 1-3/11", "accept-ranges": "bytes" }); res.end(png.slice(1, 4)); return }
    if (path === "/app/redirect") { res.writeHead(302, { location: "index.html?q=1%2F2" }); res.end(); return }
    if (path === "/app/preserve") { res.writeHead(307, { location: "/app/api" }); res.end(); return }
    if (path === "/app/escape") { const address = forbidden.address(); res.writeHead(302, { location: `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/private` }); res.end(); return }
    if (path === "/app/api") {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify({ method: req.method, body: Buffer.concat(chunks).toString(), query: req.url?.split("?")[1] ?? "" }))
      return
    }
    res.writeHead(404); res.end("missing")
  })
  const listen = (value: ReturnType<typeof createServer>) => new Promise<void>((resolve, reject) => { value.once("error", reject); value.listen(0, "127.0.0.1", resolve) })
  const close = (value: ReturnType<typeof createServer>) => new Promise<void>((resolve, reject) => { value.closeAllConnections(); value.close((error) => error ? reject(error) : resolve()) })
  const registry = RemoteLocalApp.create({ verifySession: async () => true, authorize: async () => true })
  try {
    await listen(forbidden)
    await listen(server)
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("missing fixture address")
    const owner = { ownerID: "fixture-owner", deviceID: "fixture-device", sessionID: "fixture-session" }
    const scope = { ...owner, clientID: "fixture-client", grantID: "fixture-grant", epoch: "fixture-epoch" }
    const app = await registry.register({ sessionID: owner.sessionID, host: "127.0.0.1", port: address.port, entryPath: "/app/index.html", routes: [{ path: "/app", match: "prefix", methods: ["GET", "HEAD", "POST"] }] }, owner)
    registry.publish({ id: app.id, generation: app.generation, owner, scope })
    const send = (path: string, overrides: Partial<RemoteLocalApp.Request> = {}) => registry.dispatch({ id: app.id, generation: app.generation, scope, path, method: "GET", headers: {}, ...overrides })
    const page = await send(app.entryPath)
    expect(new TextDecoder().decode(page.body)).toBe(html)
    expect(page.headers["content-type"]).toBe("text/html")
    expect(page.headers["content-security-policy"]).toBe("default-src 'self'")
    for (const [relative, expected, type] of [["style.css", "body{color:navy}", "text/css"], ["/app/app.js", 'fetch("./api")', "text/javascript"]]) {
      const asset = await send(new URL(relative, `http://fixture.invalid${app.entryPath}`).pathname)
      expect(new TextDecoder().decode(asset.body)).toBe(expected)
      expect(asset.headers["content-type"]).toBe(type)
    }
    expect((await send("/app/image.png")).body).toEqual(png)
    expect((await send("/app/image.png", { method: "HEAD" })).body.byteLength).toBe(0)
    const get = await send("/app/api?q=%E2%98%83&x=a%2Fb")
    expect(JSON.parse(new TextDecoder().decode(get.body))).toEqual({ method: "GET", body: "", query: "q=%E2%98%83&x=a%2Fb" })
    const post = await send("/app/api", { method: "POST", headers: { "content-type": "application/json" }, body: new TextEncoder().encode('{"hello":"world"}') })
    expect(JSON.parse(new TextDecoder().decode(post.body))).toMatchObject({ method: "POST", body: '{"hello":"world"}' })
    for (const [path, status] of [["empty", 204], ["cached", 304], ["missing", 404], ["error", 422]] as const) expect((await send(`/app/${path}`)).status).toBe(status)
    const range = await send("/app/range", { headers: { range: "bytes=1-3" } })
    expect(range.status).toBe(206)
    expect(range.body).toEqual(png.slice(1, 4))
    expect(range.headers["content-range"]).toBe("bytes 1-3/11")
    const before = requests.length
    expect(await send("/app/redirect")).toMatchObject({ status: 302, headers: { location: "/app/index.html?q=1%2F2" } })
    expect(await send("/app/preserve", { method: "POST" })).toMatchObject({ status: 307, headers: { location: "/app/api" } })
    await expect(send("/app/escape")).rejects.toMatchObject({ category: "redirect_rejected" })
    expect(requests.length - before).toBe(3)
    expect(forbiddenHits).toBe(0)
    const compressed = await send("/app/compressed")
    expect(new TextDecoder().decode(compressed.body)).toBe("decoded bytes")
    expect(compressed.headers["content-encoding"]).toBeUndefined()
    expect(compressed.headers["content-length"]).toBe("13")
    const node = Bun.spawn(["node", "--input-type=module", "--eval", `
      const response = await fetch(process.argv[1], { headers: { "accept-encoding": "identity" } });
      process.stdout.write(JSON.stringify({ body: await response.text(), encoding: response.headers.get("content-encoding") }));
    `, `http://127.0.0.1:${address.port}/app/compressed`], { stdout: "pipe", stderr: "pipe" })
    expect(await node.exited).toBe(0)
    expect(JSON.parse(await new Response(node.stdout).text())).toEqual({ body: "decoded bytes", encoding: "gzip" })
    expect(requests.every((request) => request.headers["accept-encoding"] === "identity")).toBe(true)
  } finally {
    registry.close()
    await Promise.all([server, forbidden].filter((value) => value.listening).map(close))
  }
})
