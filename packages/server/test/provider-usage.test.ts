import { expect, test } from "bun:test"
import { ProviderUsage, ProviderUsageV2 } from "@ycoding-ai/core/provider-usage"
import { ProviderV2 } from "@ycoding-ai/core/provider"
import { Location } from "@ycoding-ai/core/location"
import { ProjectV2 } from "@ycoding-ai/core/project"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Authorization } from "@ycoding-ai/protocol/middleware/authorization"
import { SchemaErrorMiddleware } from "@ycoding-ai/protocol/middleware/schema-error"
import { Context, Effect, Layer, Schema } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { getProviderUsage, listProviderUsage, ProviderUsageHandler } from "../src/handlers/provider-usage"
import { Api } from "../src/api"
import { LocationMiddleware, type LocationServices } from "../src/location"

const openai = ProviderV2.ID.make("openai")
const snapshot = new ProviderUsage.Snapshot({
  providerID: openai,
  label: "Codex",
  status: "available",
  source: "provider_internal_api",
  stability: "best_effort",
  updatedAt: 100,
  windows: [new ProviderUsage.Window({ id: "codex-primary", label: "5-hour", unit: "percent", used: 25 })],
})

test("provider usage handlers forward refresh and return normalized snapshots", async () => {
  const calls: unknown[] = []
  const service = ProviderUsageV2.Service.of({
    get: (input) =>
      Effect.sync(() => {
        calls.push(["get", input])
        return snapshot
      }),
    list: (input) =>
      Effect.sync(() => {
        calls.push(["list", input])
        return [snapshot]
      }),
    observe: () => Effect.die("unused"),
  })

  expect(await Effect.runPromise(listProviderUsage(service, true))).toEqual([snapshot])
  expect(await Effect.runPromise(getProviderUsage(service, openai, false))).toEqual(snapshot)
  expect(calls).toEqual([
    ["list", { refresh: true }],
    ["get", { providerID: openai, refresh: false }],
  ])
  expect(JSON.stringify(snapshot)).not.toContain("credential")
})

test("provider usage HTTP routes decode refresh and encode normalized quota with server Location", async () => {
  const calls: unknown[] = []
  const context = Context.make(Location.Service, new Location.Info({
    directory: AbsolutePath.make("/fixture"),
    project: { id: ProjectV2.ID.make("prj_usage"), directory: AbsolutePath.make("/fixture") },
  })).pipe(Context.add(ProviderUsageV2.Service, ProviderUsageV2.Service.of({
    list: (input) => Effect.sync(() => { calls.push(input); return [snapshot] }),
    get: (input) => Effect.sync(() => { calls.push(input); return snapshot }),
    observe: () => Effect.die("unused"),
  })))
  const handler = HttpRouter.toWebHandler(
    HttpApiBuilder.layer(HttpApi.make("server").add(Api.groups["server.providerUsage"])).pipe(
      Layer.provide(ProviderUsageHandler),
      Layer.provide(Layer.mergeAll(
        Layer.succeed(LocationMiddleware, (effect) => Effect.provide(effect, Context.makeUnsafe<LocationServices>(context.mapUnsafe))),
        Layer.succeed(Authorization, (effect) => effect),
        Layer.succeed(SchemaErrorMiddleware, (effect) => effect),
      )),
      Layer.provide(HttpServer.layerServices),
    ),
  )
  await using http = {
    request: (path: string) => handler.handler(new Request(`http://localhost${path}`)),
    [Symbol.asyncDispose]: () => handler.dispose(),
  }
  const list = await http.request("/api/provider/usage?refresh=true")
  expect(list.status).toBe(200)
  expect(await list.json()).toMatchObject({ location: { directory: "/fixture" }, data: [Schema.encodeSync(ProviderUsage.Snapshot)(snapshot)] })
  const get = await http.request(`/api/provider/${openai}/usage?refresh=false`)
  expect(get.status).toBe(200)
  expect(await get.json()).toMatchObject({ location: { directory: "/fixture" }, data: Schema.encodeSync(ProviderUsage.Snapshot)(snapshot) })
  expect(calls).toEqual([{ refresh: true }, { providerID: openai, refresh: false }])
})
