import { Database } from "bun:sqlite"
import { afterAll, describe, expect, mock, test } from "bun:test"
import type { WorkerEnv } from "../src/env"
import { createNoticeStorage } from "./notice-storage"

mock.module("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(readonly ctx: DurableObjectState, readonly env: WorkerEnv) {}
  },
}))

const { default: worker, DeviceRelay } = await import("../src/index")
const methods = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "PROPFIND"]
const paths = [
  "/api/mcp", "/api/mcp/", "/api/mcp/devices/device", "/api/mcp/device/device",
  ...["register", "authorize", "login", "google/callback", "consent", "token", "revoke"].map((path) => `/api/mcp/oauth/${path}`),
  "/.well-known", "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-protected-resource/api/mcp/devices/device",
  "/api/devices/device/mcp/events/authorize",
]
const queries: string[] = []
const relayCalls: string[] = []
const assetCalls: string[] = []
const env = {
  DB: {
    prepare: (query: string) => {
      queries.push(query)
      throw new Error("Database access is unavailable in this boundary fixture")
    },
  },
  DEVICE_RELAY: { getByName: (name: string) => {
    relayCalls.push(name)
    throw new Error("Retired ingress reached a Durable Object")
  } },
  ASSETS: { fetch: async (request: Request) => {
    assetCalls.push(new URL(request.url).pathname)
    return new Response("<html>asset</html>", { headers: { "content-type": "text/html" } })
  } },
} as unknown as WorkerEnv

describe("retired hosted MCP ingress", () => {
  test.each(paths)("%s returns API 404 for every method without discovery, authentication, tools, assets or forwarding", async (path) => {
    for (const method of methods) {
      const response = await worker.fetch(new Request(`https://relay.example.invalid${path}`, {
        method,
        headers: { authorization: "Bearer synthetic-token", cookie: "yc_mcp_auth=synthetic; yc_session=synthetic", origin: "https://relay.example.invalid", accept: "text/html, application/json" },
        ...(method === "GET" || method === "HEAD" ? {} : { body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' }),
      }), env)
      expect(response.status, `${method} ${path}`).toBe(404)
      expect(await response.json()).toEqual({ error: { code: "invalid_message", message: "Not found" } })
      expect(response.headers.get("www-authenticate")).toBeNull()
      expect(response.headers.get("location")).toBeNull()
      expect(response.headers.get("set-cookie")).toBeNull()
    }
    expect(relayCalls).toEqual([])
    expect(assetCalls).toEqual([])
    expect(queries.filter((query) => /\bmcp_/i.test(query))).toEqual([])
  })

  test("ordinary asset routing remains available", async () => {
    const response = await worker.fetch(new Request("https://relay.example.invalid/remote/session/ses_fixture"), env)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("<html>asset</html>")
    assetCalls.length = 0
  })
})

const database = new Database(":memory:")
afterAll(() => database.close())
const storage = createNoticeStorage(database)
const ctx = {
  storage: {
    ...storage,
    get: async () => undefined,
    put: async () => undefined,
    deleteAlarm: async () => undefined,
    setAlarm: async () => undefined,
  },
  getWebSockets: () => [],
  setWebSocketAutoResponse: () => undefined,
  blockConcurrencyWhile: (operation: () => Promise<unknown>) => operation(),
} as unknown as DurableObjectState
const priorAutoResponse = globalThis.WebSocketRequestResponsePair
globalThis.WebSocketRequestResponsePair = class {} as typeof WebSocketRequestResponsePair
afterAll(() => { globalThis.WebSocketRequestResponsePair = priorAutoResponse })

describe("DeviceRelay retired MCP boundary", () => {
  test.each(methods)("%s refuses retired internal dispatch with and without trusted headers", async (method) => {
    const relay = new DeviceRelay(ctx, env)
    for (const path of ["/_ycoding/mcp", "/_ycoding/mcp-events/authorize"])
      for (const trusted of [false, true]) {
        const response = await relay.fetch(new Request(`https://relay.internal${path}`, {
          method,
          headers: trusted ? { "x-ycoding-internal": "1", "x-ycoding-owner": "owner", "x-ycoding-device": "device", "x-ycoding-mcp-resource": "https://relay.example.invalid/api/mcp/devices/device" } : {},
        }))
        expect(response.status, `${method} ${path}, trusted=${trusted}`).toBe(404)
      }
    expect(queries.filter((query) => /\bmcp_/i.test(query))).toEqual([])
  })

  test("retains trusted presence and rejects untrusted presence", async () => {
    const relay = new DeviceRelay(ctx, env)
    expect((await relay.fetch(new Request("https://relay.internal/_ycoding/presence"))).status).toBe(404)
    const response = await relay.fetch(new Request("https://relay.internal/_ycoding/presence", { headers: { "x-ycoding-internal": "1" } }))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ online: false })
  })
})
