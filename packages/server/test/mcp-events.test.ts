import { expect, test } from "bun:test"
import { SessionMcpEvents } from "@ycoding-ai/core/mcp-events/index"
import { McpEvents } from "@ycoding-ai/protocol/groups/mcp-events"
import { Authorization } from "@ycoding-ai/protocol/middleware/authorization"
import { SchemaErrorMiddleware } from "@ycoding-ai/protocol/middleware/schema-error"
import { Effect, Layer, Logger, References, Schema } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../src/api"
import { McpEventsHandler } from "../src/handlers/mcp-events"
import { schemaErrorLayer } from "../src/middleware/schema-error"

const context: McpEvents.RequestContext = { requestID: "request_fixture", principal: { ownerID: "owner_fixture", deviceID: "device_fixture", clientID: "client_fixture" }, epoch: "epoch_fixture" }
const subscription = Schema.decodeUnknownSync(McpEvents.Subscribe)({
  name: "session.completed",
  arguments: { session_id: "ses_fixture", include_descendants: false },
  delivery: { mode: "webhook", url: "https://callback.example/events", secret: "fixture-signing-secret" },
})
const result = { id: "subscription_fixture", refreshBefore: null, cursor: "cursor_fixture", truncated: false }

function serve(options: { available?: boolean; failure?: McpEvents.Failure; schemaErrors?: boolean } = {}) {
  const calls: { method: string; input?: unknown }[] = []
  const logs: string[] = []
  const handler = HttpRouter.toWebHandler(
    HttpApiBuilder.layer(HttpApi.make("server").add(Api.groups["server.mcpEvents"])).pipe(
      Layer.provide(McpEventsHandler.pipe(Layer.provide(Layer.mergeAll(
        Layer.succeed(SessionMcpEvents.Service, SessionMcpEvents.Service.of({
          status: () => Effect.sync(() => { calls.push({ method: "status" }); return { available: options.available ?? true } }),
          list: (input) => Effect.sync(() => { calls.push({ method: "list", input }); return { events: McpEvents.Definitions } }),
          subscribe: (input) => Effect.suspend(() => {
            calls.push({ method: "subscribe", input })
            return options.failure ? Effect.fail(options.failure) : Effect.succeed(result)
          }),
          unsubscribe: (input) => Effect.suspend(() => {
            calls.push({ method: "unsubscribe", input })
            return options.failure ? Effect.fail(options.failure) : Effect.succeed({})
          }),
        })),
        Layer.succeed(Authorization, (effect) => effect),
        options.schemaErrors ? schemaErrorLayer : Layer.succeed(SchemaErrorMiddleware, (effect) => effect),
      )))),
      Layer.provide(HttpServer.layerServices),
      Layer.provide(Logger.layer([Logger.make((entry) => {
        logs.push(Bun.inspect({ message: entry.message, annotations: entry.fiber.getRef(References.CurrentLogAnnotations) }))
      })], { mergeWithExisting: false })),
    ),
  )
  return {
    calls,
    logs,
    request: (path: string, body?: unknown) => handler.handler(new Request(`http://localhost/api/remote/mcp/events/${path}`, {
      method: body === undefined ? "GET" : "POST",
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
    })),
    [Symbol.asyncDispose]: () => handler.dispose(),
  }
}

test("dispatches global Events requests once and serializes only public results", async () => {
  await using http = serve()
  expect(await (await http.request("status")).json()).toEqual({ data: { available: true } })
  expect(await (await http.request("catalog?cursor=next%2Bpage")).json()).toEqual({ data: { events: McpEvents.Definitions } })
  const subscribed = await http.request("subscribe", { context, subscription })
  expect(subscribed.status).toBe(200)
  expect(await subscribed.json()).toEqual({ data: result })
  const unsubscribe = { name: subscription.name, arguments: subscription.arguments, delivery: { mode: "webhook", url: subscription.delivery.url } }
  expect(await (await http.request("unsubscribe", { context, subscription: unsubscribe })).json()).toEqual({ data: {} })
  expect(http.calls).toEqual([
    { method: "status" },
    { method: "list", input: { cursor: "next+page" } },
    { method: "subscribe", input: { context, subscription } },
    { method: "unsubscribe", input: { context, subscription: unsubscribe } },
  ])
})

test("rejects malformed and oversized payloads before reaching the Events service", async () => {
  await using http = serve()
  for (const body of [
    {},
    { context, subscription: { ...subscription, name: "unknown" } },
    { context, subscription: { ...subscription, delivery: { ...subscription.delivery, secret: "x".repeat(257) } } },
    { context: { ...context, principal: { ...context.principal, ownerID: "" } }, subscription },
  ]) expect((await http.request("subscribe", body)).status).toBe(400)
  expect((await http.request("unsubscribe", { context, subscription: { ...subscription, delivery: {} } })).status).toBe(400)
  expect((await http.request(`catalog?cursor=${"x".repeat(1025)}`)).status).toBe(400)
  expect(http.calls).toEqual([])
})

test("preserves safe Events failure categories and reasons without request context or secrets", async () => {
  for (const failure of [
    new McpEvents.Failure({ category: "callback_endpoint", reason: "challenge_failed" }),
    new McpEvents.Failure({ category: "unauthorized", reason: "grant_revoked" }),
    new McpEvents.Failure({ category: "unavailable", reason: "authorization_unavailable" }),
  ]) {
    await using http = serve({ failure })
    for (const path of ["subscribe", "unsubscribe"]) {
      const response = await http.request(path, { context, subscription })
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ _tag: "McpEvents.Failure", category: failure.category, reason: failure.reason })
    }
    expect(http.calls.map((call) => call.method)).toEqual(["subscribe", "unsubscribe"])
  }
})

test("reports unavailable capability without registering a subscription", async () => {
  await using http = serve({ available: false })
  expect(await (await http.request("status")).json()).toEqual({ data: { available: false } })
  expect(http.calls).toEqual([{ method: "status" }])
})

test("redacts invalid Events payloads from HTTP errors and schema rejection logs", async () => {
  await using http = serve({ schemaErrors: true })
  const secret = "sensitive-fixture-secret-".repeat(12)
  const url = "https://private-callback.example/fixture-token"
  const ownerID = "private-owner-fixture"
  const requestID = "private-context-fixture"
  const response = await http.request("subscribe", {
    context: { ...context, requestID, principal: { ...context.principal, ownerID } },
    subscription: { ...subscription, delivery: { ...subscription.delivery, secret, url } },
  })
  expect(response.status).toBe(400)
  const body = await response.text()
  const logs = http.logs.join("\n")
  expect(http.logs.length).toBeGreaterThan(0)
  for (const value of [secret, url, ownerID, requestID]) {
    expect(body).not.toContain(value)
    expect(logs).not.toContain(value)
  }
  expect(JSON.parse(body)).toEqual({ _tag: "InvalidRequestError", message: "Invalid MCP Events request", kind: "Payload" })
  expect(logs).toContain("Invalid MCP Events request")
  expect(http.calls).toEqual([])
})
