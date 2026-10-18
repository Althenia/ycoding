import { afterEach, expect, test } from "bun:test"
import { ProtocolError } from "@modelcontextprotocol/server"
import { RemoteMCPTransport } from "../src/remote-mcp/transport"

const endpoint = "http://127.0.0.1:4096/api/mcp/devices/device_fixture"
const meta = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "events-fixture", version: "1" },
}
const subscription = {
  name: "session.completed",
  arguments: { session_id: "ses_events_fixture" },
  delivery: { mode: "webhook", url: "https://receiver.example/callback", secret: `whsec_${Buffer.alloc(32, 7).toString("base64")}` },
  cursor: null,
  ttlMs: 60000,
}
const definition = {
  name: "session.completed",
  description: "Verified Session work completion.",
  delivery: ["webhook"],
  inputSchema: { type: "object", properties: { session_id: { type: "string" } }, required: ["session_id"], additionalProperties: false },
  payloadSchema: { type: "object", properties: { session_id: { type: "string" } }, required: ["session_id"], additionalProperties: false },
} as const
const open: Array<{ close: () => Promise<void> }> = []

afterEach(async () => {
  await Promise.all(open.splice(0).map((transport) => transport.close()))
})

function fixture(available: boolean | "failed" = true, failed = false) {
  const seen: Array<{ method: string; params: unknown; context: string | undefined; signal: AbortSignal }> = []
  const transport = RemoteMCPTransport.create<string>({
    name: "events-fixture",
    version: "1",
    tools: [],
    call: async () => ({ content: [] }),
    events: {
      available: async (context) => {
        if (available === "failed") throw new Error("private transport diagnostic")
        return available && context === "owner-fixture"
      },
      list: async (input) => {
        seen.push({ method: "events/list", ...input })
        return { events: [definition] }
      },
      subscribe: async (input) => {
        seen.push({ method: "events/subscribe", ...input })
        if (failed) throw new ProtocolError(-32015, "Callback verification failed", { reason: "challenge_failed" })
        return { id: "sub_fixture", refreshBefore: "2026-10-18T12:00:00Z", cursor: null, truncated: false }
      },
      unsubscribe: async (input) => {
        seen.push({ method: "events/unsubscribe", ...input })
        return {}
      },
    },
  })
  open.push(transport)
  const post = async (method: string, params: Record<string, unknown> = {}, context = "owner-fixture") => {
    const response = await transport.fetch(new Request(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": method,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: meta } }),
    }), context)
    return response.json()
  }
  return { post, seen }
}

test("Events discovery preserves the extension capability without changing tools", async () => {
  const events = fixture()
  expect(await events.post("server/discover")).toMatchObject({ result: { resultType: "complete", capabilities: { tools: {}, events: {} } } })
  expect(await events.post("tools/list")).toMatchObject({ result: { tools: [] } })
  expect(events.seen).toEqual([])
})

test("all three Events methods dispatch through the authenticated request context", async () => {
  const events = fixture()
  expect(await events.post("events/list", { cursor: null })).toMatchObject({ result: { events: [definition], resultType: "complete" } })
  expect(await events.post("events/subscribe", subscription)).toMatchObject({ result: { id: "sub_fixture", cursor: null, truncated: false } })
  expect(await events.post("events/unsubscribe", { name: subscription.name, arguments: subscription.arguments, delivery: { mode: "webhook", url: subscription.delivery.url } })).toMatchObject({ result: { resultType: "complete" } })
  expect(events.seen.map((item) => item.method)).toEqual(["events/list", "events/subscribe", "events/unsubscribe"])
  expect(events.seen.map((item) => item.context)).toEqual(["owner-fixture", "owner-fixture", "owner-fixture"])
  expect(events.seen.every((item) => item.signal instanceof AbortSignal)).toBe(true)
  expect(events.seen[1].params).toEqual({ ...subscription, arguments: { ...subscription.arguments, include_descendants: false } })
})

test("unavailable Events are neither advertised nor dispatched", async () => {
  const events = fixture(false)
  const discovery = await events.post("server/discover")
  expect(discovery).toMatchObject({ result: { capabilities: { tools: {} } } })
  expect(discovery).not.toHaveProperty("result.capabilities.events")
  expect(await events.post("events/subscribe", subscription)).toMatchObject({ error: { code: -32601 } })
  expect(events.seen).toEqual([])
})

test("a request without the authorized context cannot discover or use Events", async () => {
  const events = fixture()
  const discovery = await events.post("server/discover", {}, "different-owner")
  expect(discovery).toMatchObject({ result: { capabilities: { tools: {} } } })
  expect(discovery).not.toHaveProperty("result.capabilities.events")
  expect(await events.post("events/list", {}, "different-owner")).toMatchObject({ error: { code: -32601 } })
  expect(events.seen).toEqual([])
})

test("failed capability checks leave existing tools available without exposing their cause", async () => {
  const events = fixture("failed")
  const discovery = await events.post("server/discover")
  expect(discovery).toMatchObject({ result: { capabilities: { tools: {} } } })
  expect(discovery).not.toHaveProperty("result.capabilities.events")
  expect(await events.post("tools/list")).toMatchObject({ result: { tools: [] } })
  expect(JSON.stringify(discovery)).not.toContain("private transport diagnostic")
})

test.each([
  ["events/list", { cursor: null, path: "/unrelated" }],
  ["events/subscribe", { ...subscription, path: "/unrelated" }],
  ["events/subscribe", { ...subscription, arguments: { ...subscription.arguments, directory: "/unrelated" } }],
  ["events/subscribe", { ...subscription, delivery: { ...subscription.delivery, mode: "stream" } }],
  ["events/unsubscribe", subscription],
])("%s rejects unsupported arguments before dispatch", async (method, params) => {
  const events = fixture()
  expect(await events.post(method, params)).toMatchObject({ error: { code: -32602 } })
  expect(events.seen).toEqual([])
})

test("callback failures retain their categorized protocol error without the signing secret", async () => {
  const events = fixture(true, true)
  const response = await events.post("events/subscribe", subscription)
  expect(response).toMatchObject({ error: { code: -32015, data: { reason: "challenge_failed" } } })
  expect(JSON.stringify(response)).not.toContain(subscription.delivery.secret)
  expect(JSON.stringify(response)).not.toContain(subscription.delivery.url)
})

test("parameter validation never reflects a supplied signing secret", async () => {
  const events = fixture()
  const response = await events.post("events/subscribe", { ...subscription, delivery: { ...subscription.delivery, secret: { credential: "fixture-private-signing-material" } } })
  expect(response).toMatchObject({ error: { code: -32602 } })
  expect(JSON.stringify(response)).not.toContain("fixture-private-signing-material")
  expect(events.seen).toEqual([])
})
