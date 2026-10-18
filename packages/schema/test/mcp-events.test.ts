import { expect, test } from "bun:test"
import { Schema } from "effect"
import { McpEvents } from "../src/mcp-events.js"
import { SessionID } from "../src/session-id.js"

const secret = "whsec_" + Buffer.alloc(32, 7).toString("base64")

test("subscribe accepts only the settled top-level shape with a session filter", () => {
  const value = Schema.decodeUnknownSync(McpEvents.Subscribe)({
    name: "session.permission.changed",
    arguments: { session_id: "ses_abc" },
    delivery: { mode: "webhook", url: "https://receiver.example.test/cb", secret },
    cursor: null,
  })
  expect(value.arguments).toEqual({ session_id: SessionID.make("ses_abc"), include_descendants: false })
  expect(value.delivery.mode).toBe("webhook")
  for (const bad of [
    { name: "session.unknown", arguments: { session_id: "ses_abc" }, delivery: { mode: "webhook", url: "https://x.test/cb", secret } },
    { name: "session.progress", arguments: { session_id: "not-a-session" }, delivery: { mode: "webhook", url: "https://x.test/cb", secret } },
    { name: "session.progress", arguments: {}, delivery: { mode: "webhook", url: "https://x.test/cb", secret } },
    { name: "session.progress", arguments: { session_id: "ses_abc" }, delivery: { mode: "polling", url: "https://x.test/cb", secret } },
    { name: "session.progress", arguments: { session_id: "ses_abc" }, delivery: { mode: "webhook", url: "https://x.test/cb", secret }, ttlMs: -1 },
    { name: "session.progress", arguments: { session_id: "ses_abc" }, delivery: { mode: "webhook", url: "https://x.test/cb", secret }, ttlMs: 1.5 },
  ]) expect(Schema.is(McpEvents.Subscribe)(bad)).toBe(false)
})

test("all seven event names are the settled catalog", () => {
  const names = [
    "session.guardrail.changed",
    "session.permission.changed",
    "session.question.changed",
    "session.form.changed",
    "session.progress",
    "session.completed",
    "session.error",
  ] as const
  expect(McpEvents.Names).toEqual(names)
  for (const name of names) expect(Schema.is(McpEvents.Name)(name)).toBe(true)
  expect(McpEvents.Definitions).toHaveLength(7)
  for (const definition of McpEvents.Definitions) {
    expect(definition.delivery).toEqual(["webhook"])
    expect(JSON.stringify(definition.inputSchema)).toContain("session_id")
    expect(JSON.stringify(definition.payloadSchema)).toContain("root_session_id")
    expect(JSON.stringify(definition.payloadSchema)).not.toMatch(/text|prompt|command|evidence/)
  }
})

test("unsubscribe never carries a secret and subscription result is finite-shaped", () => {
  expect(Schema.decodeUnknownSync(McpEvents.Unsubscribe, { onExcessProperty: "error" })({
    name: "session.completed",
    arguments: { session_id: "ses_abc", include_descendants: true },
    delivery: { mode: "webhook", url: "https://receiver.example.test/cb" },
  }).delivery).not.toHaveProperty("secret")
  expect(() => Schema.decodeUnknownSync(McpEvents.Unsubscribe, { onExcessProperty: "error" })({
    name: "session.completed",
    arguments: { session_id: "ses_abc" },
    delivery: { mode: "webhook", url: "https://receiver.example.test/cb", secret },
  })).toThrow()
  expect(Schema.decodeUnknownSync(McpEvents.Subscription)({
    id: "sub_1", refreshBefore: "2026-10-19T00:00:00.000Z", cursor: null, truncated: false,
  })).toEqual({ id: "sub_1", refreshBefore: "2026-10-19T00:00:00.000Z", cursor: null, truncated: false })
})

test("event data carries only identifiers, states, and bounded categories", () => {
  const payload = Schema.decodeUnknownSync(McpEvents.Payload, { onExcessProperty: "error" })({
    eventId: "evt_1",
    name: "session.error",
    timestamp: "2026-10-18T00:00:00.000Z",
    data: { session_id: "ses_abc", root_session_id: "ses_abc", state: "failed", category: "provider.transport" },
    cursor: "cur_1",
  })
  expect(payload.data.category).toBe("provider.transport")
  for (const data of [
    { session_id: "ses_abc", root_session_id: "ses_abc", state: "failed", category: "has spaces and text" },
    { session_id: "ses_abc", root_session_id: "ses_abc", state: "unknown-state" },
    { session_id: "ses_abc", root_session_id: "ses_abc", state: "failed", text: "raw" },
  ]) expect(() => Schema.decodeUnknownSync(McpEvents.EventData, { onExcessProperty: "error" })(data)).toThrow()
})

test("failures are safe tagged values with finite reasons and no echoed input", () => {
  const failure = new McpEvents.Failure({ category: "callback_endpoint", reason: "challenge_failed" })
  expect(failure._tag).toBe("McpEvents.Failure")
  expect(failure.message).not.toContain("whsec_")
  expect(() => new McpEvents.Failure({ category: "callback_endpoint", reason: "raw provider text" as never })).toThrow()
  expect(Schema.is(McpEvents.FailureCategory)("invalid_params")).toBe(true)
  expect(Schema.is(McpEvents.FailureCategory)("internal")).toBe(false)
})

test("request context is the legacy principal without a grant", () => {
  const context = Schema.decodeUnknownSync(McpEvents.RequestContext, { onExcessProperty: "error" })({
    requestID: "req_1",
    principal: { ownerID: "own_1", deviceID: "dev_1", clientID: "cli_1" },
    epoch: "epoch_1",
  })
  expect(context.principal).not.toHaveProperty("grantID")
  const principal = Schema.decodeUnknownSync(McpEvents.Principal)({ ...context.principal, grantID: "grt_1", epoch: "epoch_1" })
  expect(principal.grantID).toBe("grt_1")
})

test("clientID preserves the existing URL-based client bound without widening other scope fields", () => {
  const urlClient = "https://client.example.test/" + "a".repeat(2048 - "https://client.example.test/".length)
  expect(urlClient).toHaveLength(2048)
  const accepted = { requestID: "req_1", principal: { ownerID: "own_1", deviceID: "dev_1", clientID: urlClient }, epoch: "epoch_1" }
  expect(Schema.decodeUnknownSync(McpEvents.RequestContext)(accepted).principal.clientID).toBe(urlClient)
  expect(Schema.decodeUnknownSync(McpEvents.Principal)({ ...accepted.principal, grantID: "grt_1", epoch: "epoch_1" }).clientID).toBe(urlClient)
  for (const clientID of [urlClient + "a", "client\r\nid", "client\nid", "client\0id", ""])
    expect(Schema.is(McpEvents.RequestContext)({ ...accepted, principal: { ...accepted.principal, clientID } })).toBe(false)
  expect(Schema.is(McpEvents.RequestContext)({ ...accepted, principal: { ...accepted.principal, ownerID: "o".repeat(257) } })).toBe(false)
  expect(Schema.is(McpEvents.RequestContext)({ ...accepted, epoch: "e".repeat(257) })).toBe(false)
})
