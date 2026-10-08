import { expect, test } from "bun:test"
import { Catalog } from "@ycoding-ai/core/catalog"
import { PluginSupervisor } from "@ycoding-ai/core/plugin/supervisor"
import { Location } from "@ycoding-ai/core/location"
import { Project } from "@ycoding-ai/core/project"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { CatalogModel } from "@ycoding-ai/core/model"
import { Authorization } from "@ycoding-ai/protocol/middleware/authorization"
import { SchemaErrorMiddleware } from "@ycoding-ai/protocol/middleware/schema-error"
import { Context, Effect, Layer } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { ModelHandler } from "../src/handlers/model"
import { Api } from "../src/api"
import { LocationMiddleware, type LocationServices } from "../src/location"

function fixture(model: CatalogModel.Info | undefined, selection?: CatalogModel.Ref) {
  const context = Context.make(
    Location.Service,
    new Location.Info({
      directory: AbsolutePath.make("/fixture"),
      project: { id: Project.ID.global, directory: AbsolutePath.make("/fixture") },
    }),
  ).pipe(
    Context.add(PluginSupervisor.Service, PluginSupervisor.Service.of({ flush: Effect.void })),
    Context.add(
      Catalog.Service,
      Catalog.Service.of({
        transform: () => Effect.die("unused catalog.transform"),
        reload: () => Effect.die("unused catalog.reload"),
        provider: {
          get: () => Effect.die("unused provider.get"),
          all: () => Effect.die("unused provider.all"),
          available: () => Effect.die("unused provider.available"),
        },
        model: {
          default: () => Effect.succeed(model),
          defaultSelection: () => Effect.succeed(selection),
          forConnection: () => Effect.die("unused model.forConnection"),
          get: () => Effect.die("unused model.get"),
          all: () => Effect.die("unused model.all"),
          available: () => Effect.die("unused model.available"),
          small: () => Effect.die("unused model.small"),
        },
      }),
    ),
  )
  const handler = HttpRouter.toWebHandler(
    HttpApiBuilder.layer(HttpApi.make("server").add(Api.groups["server.model"])).pipe(
      Layer.provide(ModelHandler),
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(LocationMiddleware, (effect) =>
            Effect.provide(effect, Context.makeUnsafe<LocationServices>(context.mapUnsafe)),
          ),
          Layer.succeed(Authorization, (effect) => effect),
          Layer.succeed(SchemaErrorMiddleware, (effect) => effect),
        ),
      ),
      Layer.provide(HttpServer.layerServices),
    ),
  )
  return {
    request: () => handler.handler(new Request("http://localhost/api/model/default")),
    [Symbol.asyncDispose]: () => handler.dispose(),
  }
}

test("default model HTTP response preserves the configured profile and variant", async () => {
  const ref = CatalogModel.Ref.parse("openai/gpt-6.1-sol#high")
  const model = CatalogModel.Info.empty(ref.providerID, ref.id)
  await using http = fixture(model, { ...ref, profile: "Work" })
  const response = await http.request()
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    location: { directory: "/fixture" },
    data: { ...model, selection: { ...ref, profile: "Work" } },
  })
})

test("default model HTTP response derives a selection for an ordinary catalog default", async () => {
  const ref = CatalogModel.Ref.parse("openai/gpt-6.1-sol")
  const model = CatalogModel.Info.empty(ref.providerID, ref.id)
  await using http = fixture(model)
  const response = await http.request()
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ data: { ...model, selection: ref } })
})

test("an empty default catalog remains an empty default response", async () => {
  await using http = fixture(undefined)
  const response = await http.request()
  expect(response.status).toBe(200)
  expect((await response.json()).data).toBeNull()
})
