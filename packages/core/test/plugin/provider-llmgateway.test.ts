import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Catalog } from "@ycoding-ai/core/catalog"
import { Integration } from "@ycoding-ai/core/integration"
import { PluginRegistry } from "@ycoding-ai/core/plugin"
import { PluginHost } from "@ycoding-ai/core/plugin/host"
import { ProviderPlugins } from "@ycoding-ai/core/plugin/provider"
import { LLMGatewayPlugin } from "@ycoding-ai/core/plugin/provider/llmgateway"
import { Provider } from "@ycoding-ai/core/provider"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

const addPlugin = Effect.fn(function* () {
  const plugin = yield* PluginRegistry.Service
  const host = yield* PluginHost.make(plugin)
  const integration = yield* Integration.Service
  yield* LLMGatewayPlugin.effect(host).pipe(Effect.provideService(Integration.Service, integration))
})

describe("LLMGatewayPlugin", () => {
  it.effect("is registered so legacy referer headers can be applied", () =>
    Effect.sync(() => expect(ProviderPlugins.map((item) => item.id)).toContain("ycoding.provider.llmgateway")),
  )

  it.effect("applies legacy referer headers only to enabled llmgateway", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const integrations = yield* Integration.Service
      yield* integrations.transform((editor) => {
        editor.update(Integration.ID.make("llmgateway"), () => {})
        editor.update(Integration.ID.make("openrouter"), () => {})
      })
      yield* catalog.transform((catalog) => {
        catalog.provider.update(Provider.ID.make("llmgateway"), (provider) => {
          provider.package = Provider.aisdk("@ai-sdk/openai-compatible")
          provider.settings = { baseURL: "https://api.llmgateway.io/v1" }
          provider.headers = { Existing: "value" }
        })
        catalog.provider.update(Provider.ID.openrouter, () => {})
      })
      yield* addPlugin()
      expect((yield* catalog.provider.get(Provider.ID.make("llmgateway")))?.headers).toEqual({
        Existing: "value",
        "X-Title": "YCoding",
        "X-Source": "YCoding",
      })
      expect((yield* catalog.provider.get(Provider.ID.openrouter))?.headers).toBeUndefined()
    }),
  )

  it.effect("does not apply legacy headers to a disabled llmgateway provider", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const integrations = yield* Integration.Service
      yield* integrations.transform((editor) => {
        editor.update(Integration.ID.make("llmgateway"), () => {})
      })
      yield* catalog.transform((catalog) => {
        catalog.provider.update(Provider.ID.make("llmgateway"), (provider) => {
          provider.disabled = true
          provider.package = Provider.aisdk("@ai-sdk/openai-compatible")
          provider.settings = { baseURL: "https://api.llmgateway.io/v1" }
        })
      })
      yield* addPlugin()

      expect((yield* catalog.provider.get(Provider.ID.make("llmgateway")))?.disabled).toBe(true)
      expect((yield* catalog.provider.get(Provider.ID.make("llmgateway")))?.headers).toBeUndefined()
    }),
  )
})
