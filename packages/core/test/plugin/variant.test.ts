import { describe, expect } from "bun:test"
import { Catalog } from "@ycoding-ai/core/catalog"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { Location } from "@ycoding-ai/core/location"
import { ModelV2 } from "@ycoding-ai/core/model"
import { VariantPlugin } from "@ycoding-ai/core/plugin/variant"
import { ProviderV2 } from "@ycoding-ai/core/provider"
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
        catalog.provider.update(ProviderV2.ID.opencode, (provider) => {
          provider.package = ProviderV2.aisdk("@ai-sdk/openai-compatible")
        })
        catalog.model.update(ProviderV2.ID.opencode, ModelV2.ID.make("glm-5.2"), (model) => {
          model.modelID = ModelV2.ID.make("glm-5.2")
          model.package = ProviderV2.aisdk("@ai-sdk/openai-compatible")
        })
      })
      yield* VariantPlugin.Plugin.effect(host({ catalog: catalogHost(service) }))

      expect((yield* service.model.get(ProviderV2.ID.opencode, ModelV2.ID.make("glm-5.2")))?.variants).toEqual([
        expect.objectContaining({ id: "high", settings: { reasoningEffort: "high" } }),
        expect.objectContaining({ id: "max", settings: { reasoningEffort: "max" } }),
      ])
    }),
  )

  it.effect("keeps explicit variants over generated defaults", () =>
    Effect.gen(function* () {
      const service = yield* Catalog.Service
      yield* service.transform((catalog) => {
        catalog.model.update(ProviderV2.ID.opencode, ModelV2.ID.make("glm-5.2"), (model) => {
          model.modelID = ModelV2.ID.make("glm-5.2")
          model.package = ProviderV2.aisdk("@ai-sdk/openai-compatible")
          model.variants = [{ id: ModelV2.VariantID.make("high"), settings: {}, headers: { custom: "true" }, body: {} }]
        })
      })
      yield* VariantPlugin.Plugin.effect(host({ catalog: catalogHost(service) }))

      expect((yield* service.model.get(ProviderV2.ID.opencode, ModelV2.ID.make("glm-5.2")))?.variants).toEqual([
        expect.objectContaining({ id: "high", headers: { custom: "true" } }),
        expect.objectContaining({ id: "max", settings: { reasoningEffort: "max" } }),
      ])
    }),
  )
})
