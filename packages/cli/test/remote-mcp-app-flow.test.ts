import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { RemoteAppPreview } from "@ycoding-ai/remote"
import { RemoteLocalApp } from "../src/remote-local-app"
import { RemoteMcpApps } from "../src/remote-mcp-apps"
import { createRemoteMcp } from "../src/remote-mcp"
import { createSessionRegistry, createSubscriptions } from "../src/remote-operations"
import type { LocalServer } from "../src/remote-local"

const origin = "https://app-one.preview.test"
const context = { requestID: "request_fixture", epoch: "epoch_fixture", principal: { ownerID: "owner_fixture", deviceID: "device_fixture", clientID: "client_fixture" } }
const scope = { ...context.principal, sessionID: "ses_fixture", epoch: context.epoch, grantID: "grant_fixture" }
const meta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {}, "io.modelcontextprotocol/clientInfo": { name: "fixture", version: "1" } }
const bytes = new Uint8Array([0, 127, 128, 255, 42])

test("registered app HTTP and private bootstrap metadata cross the existing MCP transport", async () => {
  let allowed = true
  const requests: Array<{ path: string; method: string; body: string; headers: Headers }> = []
  const registry = RemoteLocalApp.create({
    now: () => 1_800_000_000_000,
    verifySession: async (id) => id === scope.sessionID,
    authorize: async () => allowed,
    fetcher: async (input, init) => {
      const url = new URL(String(input))
      const headers = new Headers(init?.headers)
      const body = init?.body instanceof Uint8Array ? new TextDecoder().decode(init.body) : String(init?.body ?? "")
      requests.push({ path: url.pathname, method: init?.method ?? "GET", body, headers })
      if (url.pathname === "/image.bin") return new Response(bytes, { headers: { "content-type": "application/octet-stream" } })
      if (url.pathname === "/assets/app.js") return new Response("document.body.dataset.ready = 'true'", { headers: { "content-type": "text/javascript" } })
      if (url.pathname === "/api/value") return Response.json({ value: body ? JSON.parse(body).value : 7 }, { status: init?.method === "POST" ? 201 : 200 })
      return new Response('<!doctype html><script src="/assets/app.js"></script><img src="./image.bin">', { headers: { "content-type": "text/html" } })
    },
  })
  const local = new Proxy({} as LocalServer, { get: (_target, key) => async () => {
    if (key === "mcpEventsStatus") return { available: false }
    if (key === "listPage") return { data: [{ id: scope.sessionID, parentID: undefined, location: { directory: "/fixture" }, time: { created: 1, updated: 1 } }] }
    if (key === "getSession") return { id: scope.sessionID, location: { directory: "/fixture" }, time: { created: 1, updated: 1 } }
    throw new Error("Unexpected local operation")
  } })
  const sessions = createSessionRegistry({ local })
  await sessions.refresh()
  let mcp: ReturnType<typeof createRemoteMcp>
  const call = async (name: string, input?: unknown) => {
    const response = await mcp.fetch(new Request("https://relay.example/api/mcp/devices/device_fixture", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": name },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { sessionID: scope.sessionID, ...(input === undefined ? {} : { input }) }, _meta: meta } }),
    }), context)
    return await response.json() as { result: { isError?: boolean; structuredContent: Record<string, unknown>; _meta?: { localApp?: { url: string; origin: string } } } }
  }
  const gateway = RemoteAppPreview.create({
    origins: [origin], frameAncestors: ["https://chat.example"], now: () => 1_800_000_000_000,
    authorize: async () => allowed,
    dispatch: async (input) => {
      const result = (await call("local_app_http", { id: input.id, generation: input.generation, method: input.method, path: input.path, headers: input.headers, ...(input.body === undefined ? {} : { body: Buffer.from(input.body).toString("base64") }) })).result
      if (result.isError) throw new Error("App unavailable")
      const value = result.structuredContent as { status: number; headers: Record<string, string>; body: string }
      return { status: value.status, headers: value.headers, body: new Uint8Array(Buffer.from(value.body, "base64")) }
    },
  })
  const apps = RemoteMcpApps.create({
    registry, now: () => 1_800_000_000_000,
    resolve: async () => { if (!allowed) throw new Error("Unavailable"); return { ...context.principal, grantID: scope.grantID, epoch: scope.epoch } },
    preview: { origins: () => [origin], issue: ({ registration, scope }) => gateway.issue({ id: registration.id, generation: registration.generation, scope, origin, entryPath: registration.entryPath, expiresAt: registration.expiresAt }) },
  })
  mcp = createRemoteMcp({ local, sessions, subscriptions: createSubscriptions(), resource: "https://relay.example/api/mcp/devices/device_fixture", allowed: () => allowed, apps })
  try {
    const registered = (await call("local_app_register", { host: "127.0.0.1", port: 41234, entryPath: "/", routes: [{ path: "/", match: "prefix", methods: ["GET", "POST"] }] })).result
    const id = registered.structuredContent.id as string
    const generation = registered.structuredContent.generation as string
    expect(typeof id).toBe("string")
    expect(typeof generation).toBe("string")
    expect(id).toMatch(/^app_/)
    expect(generation).toMatch(/^generation_/)
    const opened = (await call("local_app_open", { id, generation })).result
    expect(opened).toMatchObject({ structuredContent: { kind: "local-http-app", status: "ready", appID: id } })
    expect(JSON.stringify(opened.structuredContent)).not.toContain(origin)
    expect(JSON.stringify(opened.structuredContent)).not.toContain("ticket")
    expect(opened._meta?.localApp?.origin).toBe(origin)
    const bootstrap = await gateway.fetch(new Request(opened._meta!.localApp!.url))
    expect(bootstrap.status).toBe(303)
    expect(bootstrap.headers.get("location")).toBe("/")
    const cookie = bootstrap.headers.get("set-cookie")!.split(";")[0]
    expect((await gateway.fetch(new Request(opened._meta!.localApp!.url))).status).toBe(401)
    const html = await gateway.fetch(new Request(`${origin}/`, { headers: { cookie } }))
    expect(await html.text()).toContain('/assets/app.js')
    const script = await gateway.fetch(new Request(`${origin}/assets/app.js`, { headers: { cookie } }))
    expect(script.headers.get("content-type")).toBe("text/javascript")
    expect(await script.text()).toContain("dataset.ready")
    const binary = new Uint8Array(await (await gateway.fetch(new Request(`${origin}/image.bin`, { headers: { cookie } }))).arrayBuffer())
    expect(createHash("sha256").update(binary).digest("hex")).toBe(createHash("sha256").update(bytes).digest("hex"))
    const api = await gateway.fetch(new Request(`${origin}/api/value`, { method: "POST", headers: { cookie, origin, "content-type": "application/json" }, body: '{"value":11}' }))
    expect(api.status).toBe(201)
    expect(await api.json()).toEqual({ value: 11 })
    expect(requests.find((request) => request.method === "POST")?.headers.get("origin")).toBe("http://127.0.0.1:41234")
    expect(requests.every((request) => !request.headers.has("cookie") && !request.headers.has("authorization"))).toBe(true)
    const count = requests.length
    allowed = false
    expect((await gateway.fetch(new Request(`${origin}/`, { headers: { cookie } }))).status).toBe(403)
    expect(requests).toHaveLength(count)
  } finally {
    await mcp.close()
    apps.close()
    gateway.close()
  }
})
