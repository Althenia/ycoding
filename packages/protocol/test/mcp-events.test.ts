import { expect, test } from "bun:test"
import { Schema } from "effect"
import { OpenApi } from "effect/unstable/httpapi"
import { ClientApi, groupNames } from "../src/client.js"
import { SubscribeRequest, UnsubscribeRequest, ListQuery } from "../src/mcp-events.js"
import { SessionID } from "@ycoding-ai/schema/session-id"

const context = { requestID: "request_fixture", principal: { ownerID: "owner_fixture", deviceID: "device_fixture", clientID: "client_fixture" }, epoch: "epoch_fixture" }
const subscription = {
  name: "session.completed",
  arguments: { session_id: SessionID.make("ses_fixture") },
  delivery: { mode: "webhook", url: "https://callback.example/events", secret: "fixture-secret" },
} as const

test("keeps MCP Events request shapes without local API routes", () => {
  const document = OpenApi.fromApi(ClientApi)
  expect(Object.keys(ClientApi.groups)).not.toContain("server.mcpEvents")
  expect(Object.keys(groupNames)).not.toContain("server.mcpEvents")
  expect(Object.keys(document.paths).filter((route) => route.startsWith("/api/remote/mcp/events"))).toEqual([])
})

test("bounds Events payloads and keeps unsubscribe free of signing secrets", () => {
  const decode = Schema.decodeUnknownSync(SubscribeRequest)
  expect(decode({ context, subscription })).toEqual({ context, subscription: { ...subscription, arguments: { session_id: subscription.arguments.session_id, include_descendants: false } } })
  for (const invalid of [
    { context: { ...context, requestID: "" }, subscription },
    { context: { ...context, principal: { ...context.principal, clientID: "x".repeat(2049) } }, subscription },
    { context, subscription: { ...subscription, name: "session.unknown" } },
    { context, subscription: { ...subscription, delivery: { ...subscription.delivery, url: "x".repeat(2049) } } },
    { context, subscription: { ...subscription, delivery: { ...subscription.delivery, secret: "x".repeat(257) } } },
    { context, subscription: { ...subscription, cursor: "x".repeat(1025) } },
    { context, subscription: { ...subscription, ttlMs: -1 } },
  ]) expect(() => decode(invalid)).toThrow()
  expect(decode({ context, subscription: { ...subscription, cursor: null, ttlMs: null } }).subscription.cursor).toBeNull()
  expect(Schema.decodeUnknownSync(UnsubscribeRequest)({ context, subscription })).toEqual({
    context,
    subscription: { name: subscription.name, arguments: { session_id: subscription.arguments.session_id, include_descendants: false }, delivery: { mode: "webhook", url: subscription.delivery.url } },
  })
  const query = ListQuery
  expect(Schema.decodeUnknownSync(query)({})).toEqual({})
  expect(Schema.decodeUnknownSync(query)({ cursor: "x".repeat(1024) })).toEqual({ cursor: "x".repeat(1024) })
  expect(() => Schema.decodeUnknownSync(query)({ cursor: "x".repeat(1025) })).toThrow()
})
