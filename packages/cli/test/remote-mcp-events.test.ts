import { afterEach, expect, test } from "bun:test"
import { McpEvents } from "@ycoding-ai/schema/mcp-events"
import { createRemoteMcp } from "../src/remote-mcp"
import { createSessionRegistry, createSubscriptions } from "../src/remote-operations"
import type { LocalServer } from "../src/remote-local"

const resource = "https://relay.example/api/mcp/devices/device_fixture"
const context = { requestID: "request_fixture", epoch: "epoch_fixture", principal: { ownerID: "owner_fixture", deviceID: "device_fixture", clientID: "client_fixture" } }
const meta = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "fixture", version: "1" },
}
const subscription = {
  name: "session.completed",
  arguments: { session_id: "ses_fixture" },
  delivery: { mode: "webhook", url: "https://callback.example/events", secret: `whsec_${Buffer.alloc(32, 1).toString("base64")}` },
}
const closers: Array<() => Promise<void>> = []
afterEach(async () => { await Promise.all(closers.splice(0).map((close) => close())) })

function fixture(options: { available?: boolean; failure?: unknown } = {}) {
  const calls: Array<{ method: string; args: readonly unknown[] }> = []
  const local = new Proxy({} as LocalServer, {
    get: (_target, method: string) => async (...args: unknown[]) => {
      calls.push({ method, args })
      if (method === "mcpEventsStatus") return { available: options.available ?? true }
      if (options.failure) throw options.failure
      if (method === "mcpEventsList") return { events: McpEvents.Definitions }
      if (method === "mcpEventsSubscribe") return { id: "sub_fixture", refreshBefore: "2026-10-18T16:00:00Z", cursor: null, truncated: false }
      if (method === "mcpEventsUnsubscribe") return {}
      throw new Error("Unexpected local operation")
    },
  })
  let allowed = true
  const mcp = createRemoteMcp({ local, sessions: createSessionRegistry({ local }), subscriptions: createSubscriptions(), resource, allowed: () => allowed })
  closers.push(() => mcp.close())
  return {
    calls,
    revoke: () => { allowed = false },
    async post(method: string, params: Record<string, unknown> = {}) {
      const response = await mcp.fetch(new Request(resource, {
        method: "POST", headers: { "content-type": "application/json", accept: "application/json", "mcp-protocol-version": "2026-07-28", "mcp-method": method },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: meta } }),
      }), context)
      return response.json()
    },
  }
}

test("MCP advertises and dispatches Events through the global backend with trusted relay context", async () => {
  const app = fixture()
  expect(await app.post("server/discover")).toMatchObject({ result: { capabilities: { events: {} } } })
  expect(await app.post("events/list")).toMatchObject({ result: { events: McpEvents.Definitions } })
  expect(await app.post("events/subscribe", subscription)).toMatchObject({ result: { id: "sub_fixture" } })
  expect(app.calls.find((call) => call.method === "mcpEventsSubscribe")?.args[0]).toEqual({
    context, subscription: { ...subscription, arguments: { session_id: "ses_fixture", include_descendants: false } },
  })
  expect(await app.post("events/unsubscribe", { name: subscription.name, arguments: subscription.arguments, delivery: { mode: "webhook", url: subscription.delivery.url } })).toMatchObject({ result: { resultType: "complete" } })
  expect(app.calls.some((call) => call.method === "getSession" || call.method === "listPage")).toBe(false)
})

test("MCP omits unavailable Events and refuses calls after local epoch revocation", async () => {
  const unavailable = fixture({ available: false })
  expect(await unavailable.post("server/discover")).not.toHaveProperty("result.capabilities.events")
  expect(await unavailable.post("events/subscribe", subscription)).toMatchObject({ error: { code: -32601 } })
  expect(unavailable.calls.some((call) => call.method === "mcpEventsSubscribe")).toBe(false)
  const app = fixture()
  app.revoke()
  expect(await app.post("events/subscribe", subscription)).toEqual({ error: "unavailable" })
  expect(app.calls).toEqual([])
})

test.each([
  ["callback_endpoint", "challenge_failed", -32015],
  ["unauthorized", "grant_revoked", -32001],
  ["invalid_params", "invalid_cursor", -32602],
  ["unavailable", "authorization_unavailable", -32603],
] as const)("maps safe %s failures without reflecting callback secrets", async (category, reason, code) => {
  const app = fixture({ failure: new McpEvents.Failure({ category, reason }) })
  const result = await app.post("events/subscribe", subscription)
  expect(result).toMatchObject({ error: { code, data: { reason } } })
  expect(JSON.stringify(result)).not.toContain(subscription.delivery.url)
  expect(JSON.stringify(result)).not.toContain(subscription.delivery.secret)
})

test("an unconfirmed backend result is surfaced once without retry or private diagnostics", async () => {
  const app = fixture({ failure: new Error(`Unconfirmed response from ${subscription.delivery.url} with ${subscription.delivery.secret}`) })
  const result = await app.post("events/subscribe", subscription)
  expect(result).toMatchObject({ error: { code: -32603, data: { reason: "service_unavailable" } } })
  expect(app.calls.filter((call) => call.method === "mcpEventsSubscribe")).toHaveLength(1)
  expect(JSON.stringify(result)).not.toContain(subscription.delivery.url)
  expect(JSON.stringify(result)).not.toContain(subscription.delivery.secret)
  expect(JSON.stringify(result)).not.toContain("Unconfirmed response")
})
