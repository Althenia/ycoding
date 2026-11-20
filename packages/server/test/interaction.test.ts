import { expect, test } from "bun:test"
import { Interaction, InteractionRuntime } from "@ycoding-ai/core/interaction/index"
import { makeAuthority } from "@ycoding-ai/core/interaction/authority"
import type { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { LocationServiceMap } from "@ycoding-ai/core/location-service-map"
import { Permission } from "@ycoding-ai/core/permission"
import { SessionStore } from "@ycoding-ai/core/session/store"
import { Authorization } from "@ycoding-ai/protocol/middleware/authorization"
import { SchemaErrorMiddleware } from "@ycoding-ai/protocol/middleware/schema-error"
import { SessionSchema } from "@ycoding-ai/core/session/schema"
import { Context, Effect, Layer, Schema } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../src/api"
import { InteractionHandler } from "../src/handlers/interaction"

test("HTTP can request but cannot approve; preview and Stop stay on the owning Session and current generation", async () => {
  const authority = makeAuthority()
  const ownerID = SessionSchema.ID.make("ses_interaction_owner")
  const otherID = SessionSchema.ID.make("ses_interaction_other")
  let permitPreview = true
  const sessionInfo = (id: SessionSchema.ID) => Schema.decodeUnknownSync(SessionSchema.Info)({
    id, projectID: "global", scope: "bound", title: "Interaction fixture", location: { directory: "/fixture" },
    cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 0, updated: 0 },
  })
  const target = { kind: "chrome-tab", id: Interaction.ID.create(), label: "https://example.test/admin/settings?fixture=private", origin: "https://example.test", pathname: "/admin/settings" } as const
  const native = authority.register({
    platform: "chrome",
    inventory: async () => [target],
    attach: async () => ({ id: Interaction.ID.create() }),
    observe: async () => ({ revision: 1, elements: [], pathname: target.pathname }),
    perform: async () => ({ outcome: "applied" }),
    preview: async () => ({ mimeType: "image/png", width: 1, height: 1,
      base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==" }),
    detach: async () => {},
  })
  const permission = Layer.mock(Permission.Service, {
    evaluateEffective: ({ action, resource }) => Effect.succeed(
      !permitPreview && action === "browser_read" && resource === "https://example.test/admin/settings" ? "deny" : "allow",
    ),
  })
  const services = Layer.mergeAll(
    Layer.succeed(InteractionRuntime.Service, authority),
    Layer.mock(SessionStore.Service, { get: (id) => Effect.succeed(id === ownerID || id === otherID ? sessionInfo(id) : undefined) }),
    Layer.mock(LocationServiceMap.Service, {
      get: <const Items extends LocationServiceMap.Nodes>() => Layer.effectContext(Layer.build(permission).pipe(
        Effect.map((context) => Context.makeUnsafe<LayerNode.Output<Items[number]>>(context.mapUnsafe)),
      )),
    }),
    Layer.succeed(Authorization, (effect) => effect),
    Layer.succeed(SchemaErrorMiddleware, (effect) => effect),
  )
  const http = HttpRouter.toWebHandler(HttpApiBuilder.layer(HttpApi.make("server").add(Api.groups["server.interaction"])).pipe(
    Layer.provide(InteractionHandler.pipe(Layer.provide(services))), Layer.provide(HttpServer.layerServices),
  ))
  const request = (sessionID: SessionSchema.ID, path = "", body?: unknown) => http.handler(new Request(
    "http://localhost/api/session/" + sessionID + "/interaction" + path,
    body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
  ))
  try {
    const initiated = await request(ownerID, "", { platform: "chrome", authorization: "forged" })
    expect(initiated.status).toBe(200)
    const pending = Schema.decodeUnknownSync(Schema.Struct({ data: Interaction.Status }))(await initiated.json()).data
    if (pending.state !== "pending") throw new Error("Expected a pending native request")
    const candidate = native.pending()[0]
    expect((await request(ownerID, "/approve", { candidateID: candidate.candidateID, authorization: "forged" })).status).toBe(404)
    expect(await (await request(ownerID)).json()).toEqual({ data: pending })
    await native.inventory(candidate.candidateID)
    expect(await native.approve({ candidateID: candidate.candidateID, sessionID: ownerID, targetID: target.id, authorization: "native-proof" })).toBe(true)
    expect(await (await request(ownerID)).json()).toEqual({ data: {
      state: "active", generation: pending.generation, platform: "chrome", label: "Selected Chrome tab",
    } })
    const previewPath = "/preview?generation=" + pending.generation
    expect(await (await request(otherID, previewPath)).json()).toEqual({ data: { state: "unavailable", generation: pending.generation } })
    expect((await request(otherID, "/stop", { generation: pending.generation })).status).toBe(409)
    const preview = await request(ownerID, previewPath)
    expect(preview.headers.get("cache-control")).toBe("no-store")
    expect(await preview.json()).toMatchObject({ data: { state: "ready" } })
    permitPreview = false
    expect(await (await request(ownerID, previewPath)).json()).toEqual({ data: { state: "unavailable", generation: pending.generation } })
    expect((await request(ownerID, "/stop", { generation: pending.generation })).status).toBe(200)
    expect(await (await request(ownerID, previewPath)).json()).toEqual({ data: { state: "unavailable", generation: pending.generation } })
  } finally {
    native.disconnect()
    await http.dispose()
  }
})
