import { AISDK } from "@ycoding-ai/core/aisdk"
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { CatalogModel } from "@ycoding-ai/core/model"
import { PluginRegistry } from "@ycoding-ai/core/plugin"
import { PluginHost } from "@ycoding-ai/core/plugin/host"
import { OpenAICompatiblePlugin } from "@ycoding-ai/core/plugin/provider/openai-compatible"
import { Provider } from "@ycoding-ai/core/provider"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

const addPlugin = Effect.fn(function* () {
  const plugin = yield* PluginRegistry.Service
  const aisdk = yield* AISDK.Service
  const host = yield* PluginHost.make(plugin)
  yield* OpenAICompatiblePlugin.effect(host)
})

describe("OpenAICompatiblePlugin", () => {
  it.effect("preserves explicit includeUsage false and defaults it to true", () =>
    Effect.gen(function* () {
      const plugin = yield* PluginRegistry.Service
      const aisdk = yield* AISDK.Service
      yield* addPlugin()
      const defaulted = yield* aisdk.runSDK({
        model: CatalogModel.Info.make({
          ...CatalogModel.Info.empty(Provider.ID.make("custom"), CatalogModel.ID.make("model")),
          modelID: CatalogModel.ID.make("model"),
          package: "aisdk:test-provider",
        }),
        package: "@ai-sdk/openai-compatible",
        options: { name: "custom" },
      })
      const disabled = yield* aisdk.runSDK({
        model: CatalogModel.Info.make({
          ...CatalogModel.Info.empty(Provider.ID.make("custom"), CatalogModel.ID.make("model")),
          modelID: CatalogModel.ID.make("model"),
          package: "aisdk:test-provider",
        }),
        package: "@ai-sdk/openai-compatible",
        options: { name: "custom", includeUsage: false },
      })
      expect(defaulted.options.includeUsage).toBe(true)
      expect(disabled.options.includeUsage).toBe(false)
    }),
  )

  it.effect("defaults includeUsage for OpenAI-compatible package matches", () =>
    Effect.gen(function* () {
      const plugin = yield* PluginRegistry.Service
      const aisdk = yield* AISDK.Service
      yield* addPlugin()
      const result = yield* aisdk.runSDK({
        model: CatalogModel.Info.make({
          ...CatalogModel.Info.empty(Provider.ID.make("custom"), CatalogModel.ID.make("model")),
          modelID: CatalogModel.ID.make("model"),
          package: "aisdk:test-provider",
        }),
        package: "file:///tmp/@ai-sdk/openai-compatible-provider.js",
        options: { name: "custom" },
      })
      expect(result.options.includeUsage).toBe(true)
    }),
  )

  it.effect("uses the provider ID as the OpenAI-compatible provider name", () =>
    Effect.gen(function* () {
      const plugin = yield* PluginRegistry.Service
      const aisdk = yield* AISDK.Service
      const observed: string[] = []
      yield* addPlugin()
      yield* aisdk.hook.sdk((event) =>
        Effect.sync(() => {
          observed.push(event.sdk.languageModel("model").provider)
        }),
      )
      yield* aisdk.runSDK({
        model: CatalogModel.Info.make({
          ...CatalogModel.Info.empty(Provider.ID.make("custom-provider"), CatalogModel.ID.make("model")),
          modelID: CatalogModel.ID.make("model"),
          package: "aisdk:test-provider",
        }),
        package: "@ai-sdk/openai-compatible",
        options: { name: "custom-provider", baseURL: "https://example.com/v1" },
      })
      expect(observed).toEqual(["custom-provider.chat"])
    }),
  )

  it.effect("does not overwrite an SDK created by an earlier provider-specific plugin", () =>
    Effect.gen(function* () {
      const aisdk = yield* AISDK.Service
      const sentinel = { languageModel: (modelID: string) => ({ modelID }) }
      yield* aisdk.hook.sdk((event) => {
        event.sdk = sentinel
      })
      yield* addPlugin()
      const result = yield* aisdk.runSDK({
        model: CatalogModel.Info.make({
          ...CatalogModel.Info.empty(Provider.ID.make("cloudflare-workers-ai"), CatalogModel.ID.make("model")),
          modelID: CatalogModel.ID.make("model"),
          package: "aisdk:test-provider",
        }),
        package: "@ai-sdk/openai-compatible",
        options: { name: "cloudflare-workers-ai" },
      })
      expect(result.sdk).toBe(sentinel)
    }),
  )
})
