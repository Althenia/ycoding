import { AISDK } from "@ycoding-ai/core/aisdk"
import type { LanguageModelV3 } from "@ai-sdk/provider"
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Integration } from "@ycoding-ai/core/integration"
import { CatalogModel } from "@ycoding-ai/core/model"
import { PluginRegistry } from "@ycoding-ai/core/plugin"
import { PluginHost } from "@ycoding-ai/core/plugin/host"
import { XAIPlugin } from "@ycoding-ai/core/plugin/provider/xai"
import { Provider } from "@ycoding-ai/core/provider"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

const addPlugin = Effect.fn(function* () {
  const plugin = yield* PluginRegistry.Service
  const host = yield* PluginHost.make(plugin)
  yield* XAIPlugin.effect(host)
})

function fakeSelectorSdk(calls: string[]) {
  const make = (method: string) => (id: string) => {
    calls.push(`${method}:${id}`)
    return { modelId: id, provider: method, specificationVersion: "v3" } as unknown as LanguageModelV3
  }
  return {
    responses: make("responses"),
    messages: make("messages"),
    chat: make("chat"),
    languageModel: make("languageModel"),
  }
}

describe("XAIPlugin", () => {
  it.effect("registers browser OAuth, device OAuth, and API key methods", () =>
    Effect.gen(function* () {
      yield* addPlugin()
      const integrations = yield* Integration.Service
      const integration = yield* integrations.get(Integration.ID.make("xai"))
      expect(integration?.name).toBe("xAI")
      expect(integration?.methods).toEqual([
        {
          id: Integration.MethodID.make("browser"),
          type: "oauth",
          label: "xAI Grok OAuth (SuperGrok Subscription)",
        },
        {
          id: Integration.MethodID.make("device"),
          type: "oauth",
          remote: true,
          label: "xAI Grok OAuth (Headless / Remote / VPS)",
        },
        { type: "key", label: "Manually enter API Key" },
      ])
    }),
  )

  it.effect("uses responses with the model modelID for xAI language models", () =>
    Effect.gen(function* () {
      const aisdk = yield* AISDK.Service
      const calls: string[] = []

      yield* addPlugin()
      const result = yield* aisdk.runLanguage({
        model: CatalogModel.Info.make({
          ...CatalogModel.Info.empty(Provider.ID.make("xai"), CatalogModel.ID.make("alias")),
          modelID: CatalogModel.ID.make("grok-4"),
          package: "aisdk:@ai-sdk/xai",
        }),
        sdk: fakeSelectorSdk(calls),
        options: {},
      })

      expect(calls).toEqual(["responses:grok-4"])
      expect(result.language).toBeDefined()
    }),
  )

  it.effect("ignores non-xAI providers", () =>
    Effect.gen(function* () {
      const aisdk = yield* AISDK.Service
      const calls: string[] = []

      yield* addPlugin()
      const result = yield* aisdk.runLanguage({
        model: CatalogModel.Info.make({
          ...CatalogModel.Info.empty(Provider.ID.openai, CatalogModel.ID.make("grok-4")),
          modelID: CatalogModel.ID.make("grok-4"),
          package: "aisdk:@ai-sdk/xai",
        }),
        sdk: fakeSelectorSdk(calls),
        options: {},
      })

      expect(calls).toEqual([])
      expect(result.language).toBeUndefined()
    }),
  )
})
