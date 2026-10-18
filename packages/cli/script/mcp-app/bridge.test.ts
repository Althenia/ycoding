import { expect, test } from "bun:test"
import { createMcpAppBridge } from "./bridge.js"

class FakeWindow extends EventTarget {
  sent: { message: unknown; origin: unknown }[] = []
  postMessage(message: unknown, origin: unknown) {
    this.sent.push({ message, origin })
  }
}

const hostOrigin = "https://host.example"

function setup(options: Record<string, unknown> = {}) {
  const self = new FakeWindow()
  const parent = new FakeWindow()
  const child = new FakeWindow()
  const bridge = createMcpAppBridge({
    window: self,
    parent,
    appInfo: { name: "test-app", version: "1.0.0" },
    allowedTools: ["agent_eval_dashboard_data"],
    initializeTimeoutMs: 50,
    requestTimeoutMs: 50,
    ...options,
  })
  const deliver = (data: unknown, source: unknown = parent, origin: unknown = hostOrigin) =>
    self.dispatchEvent(Object.assign(new Event("message"), { data, source, origin }))
  const answerInitialize = (overrides: Record<string, unknown> = {}) =>
    deliver({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2026-01-26", hostInfo: { name: "fixture-host", version: "2" }, hostCapabilities: {}, hostContext: {}, ...overrides } })
  const sentMethods = () => parent.sent.map((entry) => (entry.message as { method?: unknown }).method)
  return { self, parent, child, bridge, deliver, answerInitialize, sentMethods }
}

test("initialize sends one ui/initialize, acknowledges only a bound-parent answer selecting 2026-01-26", async () => {
  const { parent, child, bridge, deliver, answerInitialize, sentMethods } = setup()
  const pending = bridge.initialize()
  expect(parent.sent).toHaveLength(1)
  expect(parent.sent[0]?.message).toEqual({
    jsonrpc: "2.0",
    id: 1,
    method: "ui/initialize",
    params: { protocolVersion: "2026-01-26", appInfo: { name: "test-app", version: "1.0.0" }, appCapabilities: {} },
  })
  deliver({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2026-01-26", hostInfo: { name: "child", version: "9" } } }, child, "null")
  deliver({ jsonrpc: "2.0", id: 99, result: { protocolVersion: "2026-01-26", hostInfo: { name: "wrong-id", version: "9" } } })
  answerInitialize()
  await expect(pending).resolves.toEqual({ name: "fixture-host", version: "2" })
  expect(sentMethods()).toEqual(["ui/initialize", "ui/notifications/initialized"])
  expect(bridge.state).toBe("initialized")
  answerInitialize()
  expect(sentMethods()).toEqual(["ui/initialize", "ui/notifications/initialized"])
  bridge.dispose()
})

test("initialize rejects without a host window and sends nothing", async () => {
  const self = new FakeWindow()
  const bridge = createMcpAppBridge({ window: self, parent: self, appInfo: { name: "t", version: "1" }, allowedTools: [] })
  await expect(bridge.initialize()).rejects.toMatchObject({ code: "not-embedded" })
  expect(self.sent).toEqual([])
})

test("initialize rejects a host error, an invalid result, a wrong protocol, and a timeout without echoing payloads", async () => {
  const rejected = setup()
  const rejectedPending = rejected.bridge.initialize()
  rejected.deliver({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "no ".repeat(40), data: { secret: "x" } } })
  const rejectedError = await rejectedPending.catch((error: unknown) => error) as { code: string; hostMessage?: string; message: string }
  expect(rejectedError.code).toBe("rejected")
  expect(rejectedError.hostMessage?.length).toBeLessThanOrEqual(64)
  expect(rejectedError.message).not.toContain("secret")

  const invalid = setup()
  const invalidPending = invalid.bridge.initialize()
  invalid.deliver({ jsonrpc: "2.0", id: 1, result: "ok" })
  await expect(invalidPending).rejects.toMatchObject({ code: "invalid-result" })

  const wrong = setup()
  const wrongPending = wrong.bridge.initialize()
  wrong.answerInitialize({ protocolVersion: "2025-01-01" })
  await expect(wrongPending).rejects.toMatchObject({ code: "protocol-mismatch" })

  const slow = setup()
  await expect(slow.bridge.initialize()).rejects.toMatchObject({ code: "timeout" })
})

test("tool results are buffered until initialized and accepted only from the bound parent and origin", async () => {
  const received: unknown[] = []
  const { child, bridge, deliver, answerInitialize } = setup({ onToolResult: (params: unknown) => received.push(params) })
  const pending = bridge.initialize()
  deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: { n: 1 } } })
  expect(received).toEqual([])
  answerInitialize()
  await pending
  expect(received).toEqual([{ structuredContent: { n: 1 } }])
  deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: { n: 2 } } }, child, "null")
  deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: { n: 3 } } }, undefined, "https://other.example")
  deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: { n: 4 } } })
  expect(received).toEqual([{ structuredContent: { n: 1 } }, { structuredContent: { n: 4 } }])
  bridge.dispose()
})

test("tools/call is limited to the per-instance allowlist and correlates strictly by id", async () => {
  const { parent, bridge, deliver, answerInitialize, sentMethods } = setup()
  await expect(bridge.callTool("agent_eval_dashboard_data", {})).rejects.toMatchObject({ code: "unavailable" })
  const pending = bridge.initialize()
  answerInitialize()
  await pending
  const before = parent.sent.length
  await expect(bridge.callTool("session_delete", {})).rejects.toMatchObject({ code: "tool-not-allowed" })
  await expect(bridge.callTool("fetch", { url: "https://example.com" })).rejects.toMatchObject({ code: "tool-not-allowed" })
  expect(parent.sent).toHaveLength(before)

  const call = bridge.callTool("agent_eval_dashboard_data", { sessionID: "ses_fixture", viewID: "view_fixture" })
  const sent = parent.sent.at(-1)?.message as { id: number; method: string; params: unknown }
  expect(sent.method).toBe("tools/call")
  expect(sent.params).toEqual({ name: "agent_eval_dashboard_data", arguments: { sessionID: "ses_fixture", viewID: "view_fixture" } })
  deliver({ jsonrpc: "2.0", id: sent.id + 100, result: { structuredContent: { wrong: true } } })
  deliver({ jsonrpc: "2.0", id: sent.id, result: { structuredContent: { ok: true } } })
  await expect(call).resolves.toEqual({ structuredContent: { ok: true } })
  deliver({ jsonrpc: "2.0", id: sent.id, result: { structuredContent: { again: true } } })
  expect(sentMethods().filter((method) => method === "tools/call")).toHaveLength(1)
  bridge.dispose()
})

test("an empty allowlist can never send tools/call", async () => {
  const { parent, bridge, answerInitialize } = setup({ allowedTools: [] })
  const pending = bridge.initialize()
  answerInitialize()
  await pending
  await expect(bridge.callTool("agent_eval_dashboard_data", {})).rejects.toMatchObject({ code: "tool-not-allowed" })
  expect(parent.sent.map((entry) => (entry.message as { method?: unknown }).method)).toEqual(["ui/initialize", "ui/notifications/initialized"])
  bridge.dispose()
})

test("dispose rejects pending work, aborts in-flight calls, and ignores later messages", async () => {
  const received: unknown[] = []
  const { bridge, deliver, answerInitialize } = setup({ onToolResult: (params: unknown) => received.push(params) })
  const pending = bridge.initialize()
  answerInitialize()
  await pending
  const controller = new AbortController()
  const aborted = bridge.callTool("agent_eval_dashboard_data", {}, { signal: controller.signal })
  controller.abort()
  await expect(aborted).rejects.toMatchObject({ code: "aborted" })
  const inFlight = bridge.callTool("agent_eval_dashboard_data", {})
  bridge.dispose()
  await expect(inFlight).rejects.toMatchObject({ code: "disposed" })
  await expect(bridge.callTool("agent_eval_dashboard_data", {})).rejects.toMatchObject({ code: "disposed" })
  deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: { late: true } } })
  expect(received).toEqual([])
  expect(bridge.state).toBe("disposed")
})
