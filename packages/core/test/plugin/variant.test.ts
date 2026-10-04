import { describe, expect } from "bun:test"
import { Catalog } from "@ycoding-ai/core/catalog"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { Location } from "@ycoding-ai/core/location"
import { CatalogModel } from "@ycoding-ai/core/model"
import { VariantPlugin } from "@ycoding-ai/core/plugin/variant"
import { Provider } from "@ycoding-ai/core/provider"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Effect, Layer } from "effect"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"
import { catalogHost, host } from "./host"

const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make(import.meta.dir) })),
)
const it = testEffect(AppNodeBuilder.build(Catalog.node, [[Location.node, locationLayer]]))

describe("VariantPlugin", () => {
  it.effect("adds GLM 5.2 variants after catalog sources", () =>
    Effect.gen(function* () {
      const service = yield* Catalog.Service
      yield* service.transform((catalog) => {
        catalog.provider.update(Provider.ID.opencode, (provider) => {
          provider.package = Provider.aisdk("@ai-sdk/openai-compatible")
        })
        catalog.model.update(Provider.ID.opencode, CatalogModel.ID.make("glm-5.2"), (model) => {
          model.modelID = CatalogModel.ID.make("glm-5.2")
          model.package = Provider.aisdk("@ai-sdk/openai-compatible")
        })
      })
      yield* VariantPlugin.Plugin.effect(host({ catalog: catalogHost(service) }))

      expect((yield* service.model.get(Provider.ID.opencode, CatalogModel.ID.make("glm-5.2")))?.variants).toEqual([
        expect.objectContaining({ id: "high", settings: { reasoningEffort: "high" } }),
        expect.objectContaining({ id: "max", settings: { reasoningEffort: "max" } }),
      ])
    }),
  )

  it.effect("keeps explicit variants over generated defaults", () =>
    Effect.gen(function* () {
      const service = yield* Catalog.Service
      yield* service.transform((catalog) => {
        catalog.model.update(Provider.ID.opencode, CatalogModel.ID.make("glm-5.2"), (model) => {
          model.modelID = CatalogModel.ID.make("glm-5.2")
          model.package = Provider.aisdk("@ai-sdk/openai-compatible")
          model.variants = [{ id: CatalogModel.VariantID.make("high"), settings: {}, headers: { custom: "true" }, body: {} }]
        })
      })
      yield* VariantPlugin.Plugin.effect(host({ catalog: catalogHost(service) }))

      expect((yield* service.model.get(Provider.ID.opencode, CatalogModel.ID.make("glm-5.2")))?.variants).toEqual([
        expect.objectContaining({ id: "high", headers: { custom: "true" } }),
        expect.objectContaining({ id: "max", settings: { reasoningEffort: "max" } }),
      ])
    }),
  )
})
