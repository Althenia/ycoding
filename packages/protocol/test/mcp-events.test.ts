import { expect, test } from "bun:test"
import { Schema } from "effect"
import { OpenApi } from "effect/unstable/httpapi"
import { ClientApi, groupNames } from "../src/client.js"
import { McpEventsGroup, SubscribeRequest, UnsubscribeRequest, ListQuery } from "../src/groups/mcp-events.js"
import { SessionID } from "@ycoding-ai/schema/session-id"
import { Authorization } from "../src/middleware/authorization.js"
import { SchemaErrorMiddleware } from "../src/middleware/schema-error.js"

const context = { requestID: "request_fixture", principal: { ownerID: "owner_fixture", deviceID: "device_fixture", clientID: "client_fixture" }, epoch: "epoch_fixture" }
const subscription = {
  name: "session.completed",
  arguments: { session_id: SessionID.make("ses_fixture") },
  delivery: { mode: "webhook", url: "https://callback.example/events", secret: "fixture-secret" },
} as const

test("registers exact global MCP Events routes with standard API middleware", () => {
  const group = ClientApi.groups["server.mcpEvents"]
  const document = OpenApi.fromApi(ClientApi)
  expect(groupNames["server.mcpEvents"]).toBe("mcpEvents")
  expect(Object.keys(McpEventsGroup.endpoints)).toEqual(["mcpEvents.status", "mcpEvents.list", "mcpEvents.subscribe", "mcpEvents.unsubscribe"])
  for (const [name, method, route] of [
    ["mcpEvents.status", "get", "status"],
    ["mcpEvents.list", "get", "catalog"],
    ["mcpEvents.subscribe", "post", "subscribe"],
    ["mcpEvents.unsubscribe", "post", "unsubscribe"],
  ] as const) {
    const endpoint = group.endpoints[name]
    const operation = document.paths[`/api/remote/mcp/events/${route}`]?.[method]
    expect(endpoint.middlewares.size).toBe(2)
    expect(endpoint.middlewares.has(Authorization)).toBe(true)
    expect(endpoint.middlewares.has(SchemaErrorMiddleware)).toBe(true)
    expect(operation?.operationId).toBe(name)
    expect(operation?.responses["200"]).toBeDefined()
    expect(operation?.responses["401"]).toBeDefined()
    expect(operation?.parameters?.some((parameter) => !("$ref" in parameter) && parameter.name === "location") ?? false).toBe(false)
    expect(Object.keys(group.endpoints).some((other) => other.startsWith(`${name}.`))).toBe(false)
  }
  const catalog = document.paths["/api/remote/mcp/events/catalog"]?.get
  expect(catalog?.parameters).toMatchObject([{ name: "cursor", in: "query", required: false, schema: { anyOf: [{ type: "string", allOf: [{ maxLength: 1024 }] }, { type: "null" }] } }])
  expect(document.paths["/api/remote/mcp/events/subscribe"]?.post?.responses["400"]).toBeDefined()
  expect(document.paths["/api/remote/mcp/events/unsubscribe"]?.post?.responses["400"]).toBeDefined()
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
