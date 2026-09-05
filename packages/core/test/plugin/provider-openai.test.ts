import { AISDK } from "@ycoding-ai/core/aisdk"
import { Money } from "@ycoding-ai/schema/money"
import { describe, expect } from "bun:test"
import type { LanguageModelV3 } from "@ai-sdk/provider"
import { Effect } from "effect"
import { Catalog } from "@ycoding-ai/core/catalog"
import { Credential } from "@ycoding-ai/core/credential"
import { Integration } from "@ycoding-ai/core/integration"
import { ModelV2 } from "@ycoding-ai/core/model"
import { PluginV2 } from "@ycoding-ai/core/plugin"
import { PluginHost } from "@ycoding-ai/core/plugin/host"
import { OpenAIPlugin } from "@ycoding-ai/core/plugin/provider/openai"
import { ProviderV2 } from "@ycoding-ai/core/provider"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

const addPlugin = Effect.fn(function* () {
  const plugin = yield* PluginV2.Service
  const aisdk = yield* AISDK.Service
  const host = yield* PluginHost.make(plugin)
  const integrations = yield* Integration.Service
  yield* OpenAIPlugin.effect(host).pipe(Effect.provideService(Integration.Service, integrations))
})

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected value")
  return value
}

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

describe("OpenAIPlugin", () => {
  it.effect("registers browser and headless ChatGPT OAuth methods", () =>
    Effect.gen(function* () {
      yield* addPlugin()
      expect((yield* (yield* Integration.Service).get(Integration.ID.make("openai")))?.methods).toEqual([
        {
          id: Integration.MethodID.make("chatgpt-browser"),
          type: "oauth",
          label: "ChatGPT Pro/Plus (browser)",
        },
        {
          id: Integration.MethodID.make("chatgpt-headless"),
          type: "oauth",
          label: "ChatGPT Pro/Plus (headless)",
        },
      ])
    }),
  )

  it.effect("creates an OpenAI SDK for @ai-sdk/openai using the provider ID as SDK name", () =>
    Effect.gen(function* () {
      const plugin = yield* PluginV2.Service
      const aisdk = yield* AISDK.Service
      yield* addPlugin()
      const result = yield* aisdk.runSDK({
        model: ModelV2.Info.make({
          ...ModelV2.Info.empty(ProviderV2.ID.make("custom-openai"), ModelV2.ID.make("gpt-5")),
          modelID: ModelV2.ID.make("gpt-5"),
          package: ProviderV2.aisdk("test-provider"),
        }),
        package: "@ai-sdk/openai",
        options: { name: "custom-openai", apiKey: "test" },
      })
      expect(result.sdk?.responses("gpt-5").provider).toBe("custom-openai.responses")
    }),
  )

  it.effect("ignores non-OpenAI SDK packages", () =>
    Effect.gen(function* () {
      const plugin = yield* PluginV2.Service
      const aisdk = yield* AISDK.Service
      yield* addPlugin()
      const result = yield* aisdk.runSDK({
        model: ModelV2.Info.make({
          ...ModelV2.Info.empty(ProviderV2.ID.openai, ModelV2.ID.make("gpt-5")),
          modelID: ModelV2.ID.make("gpt-5"),
          package: ProviderV2.aisdk("test-provider"),
        }),
        package: "@ai-sdk/openai-compatible",
        options: { name: "openai" },
      })
      expect(result.sdk).toBeUndefined()
    }),
  )

  it.effect("uses the Responses API for language models", () =>
    Effect.gen(function* () {
      const plugin = yield* PluginV2.Service
      const aisdk = yield* AISDK.Service
      const calls: string[] = []
      yield* addPlugin()
      const result = yield* aisdk.runLanguage({
        model: ModelV2.Info.make({
          ...ModelV2.Info.empty(ProviderV2.ID.openai, ModelV2.ID.make("alias")),
          modelID: ModelV2.ID.make("gpt-5"),
          package: ProviderV2.aisdk("test-provider"),
        }),
        sdk: fakeSelectorSdk(calls),
        options: {},
      })
      expect(calls).toEqual(["responses:gpt-5"])
      expect(result.language).toBeDefined()
    }),
  )

  it.effect("ignores non-OpenAI providers", () =>
    Effect.gen(function* () {
      const plugin = yield* PluginV2.Service
      const aisdk = yield* AISDK.Service
      const calls: string[] = []
      yield* addPlugin()
      const result = yield* aisdk.runLanguage({
        model: ModelV2.Info.make({
          ...ModelV2.Info.empty(ProviderV2.ID.anthropic, ModelV2.ID.make("gpt-5")),
          modelID: ModelV2.ID.make("gpt-5"),
          package: ProviderV2.aisdk("test-provider"),
        }),
        sdk: fakeSelectorSdk(calls),
        options: {},
      })
      expect(calls).toEqual([])
      expect(result.language).toBeUndefined()
    }),
  )

  it.effect("disables gpt-5-chat-latest during catalog transforms", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      yield* catalog.transform((catalog) => {
        const item = ProviderV2.Info.make({
          ...ProviderV2.Info.empty(ProviderV2.ID.openai),
          package: ProviderV2.aisdk("@ai-sdk/openai"),
        })
        catalog.provider.update(item.id, (draft) => {
          draft.package = item.package
        })
        catalog.model.update(item.id, ModelV2.ID.make("gpt-5"), () => {})
        catalog.model.update(item.id, ModelV2.ID.make("gpt-5-chat-latest"), () => {})
      })
      yield* addPlugin()
      expect(required(yield* catalog.model.get(ProviderV2.ID.openai, ModelV2.ID.make("gpt-5"))).enabled).toBe(true)
      expect(
        required(yield* catalog.model.get(ProviderV2.ID.openai, ModelV2.ID.make("gpt-5-chat-latest"))).enabled,
      ).toBe(false)
    }),
  )

  it.effect("preserves gpt-5.6 context limits from master data for the OpenAI catalog", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const family = ["gpt-5.6", "gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"]
      const masterLimit = { context: 1_050_000, input: 922_000, output: 128_000 }
      yield* catalog.transform((catalog) => {
        const item = ProviderV2.Info.make({
          ...ProviderV2.Info.empty(ProviderV2.ID.openai),
          package: ProviderV2.aisdk("@ai-sdk/openai"),
        })
        catalog.provider.update(item.id, (draft) => {
          draft.package = item.package
        })
        for (const id of family) {
          catalog.model.update(item.id, ModelV2.ID.make(id), (model) => {
            model.limit = { ...masterLimit }
          })
        }
        catalog.model.update(item.id, ModelV2.ID.make("gpt-5.5"), (model) => {
          model.limit = { context: 400_000, input: 300_000, output: 100_000 }
        })
        catalog.model.update(ProviderV2.ID.openrouter, ModelV2.ID.make("gpt-5.6"), (model) => {
          model.limit = { ...masterLimit }
        })
      })
      yield* addPlugin()

      for (const id of family) {
        expect(required(yield* catalog.model.get(ProviderV2.ID.openai, ModelV2.ID.make(id))).limit).toEqual(
          masterLimit,
        )
      }
      expect(required(yield* catalog.model.get(ProviderV2.ID.openai, ModelV2.ID.make("gpt-5.5"))).limit).toEqual({
        context: 400_000,
        input: 300_000,
        output: 100_000,
      })
      expect(required(yield* catalog.model.get(ProviderV2.ID.openrouter, ModelV2.ID.make("gpt-5.6"))).limit).toEqual(
        masterLimit,
      )
    }),
  )

  it.effect("filters the OpenAI catalog to codex-eligible models under a ChatGPT connection", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const credentials = yield* Credential.Service
      yield* catalog.transform((catalog) => {
        const item = ProviderV2.Info.make({
          ...ProviderV2.Info.empty(ProviderV2.ID.openai),
          package: ProviderV2.aisdk("@ai-sdk/openai"),
        })
        catalog.provider.update(item.id, (draft) => {
          draft.package = item.package
        })
        catalog.model.update(item.id, ModelV2.ID.make("gpt-5.5"), (model) => {
          model.cost = [
            {
              input: Money.USDPerMillionTokens.make(1),
              output: Money.USDPerMillionTokens.make(2),
              cache: {
                read: Money.USDPerMillionTokens.make(0.1),
                write: Money.USDPerMillionTokens.zero,
              },
            },
          ]
        })
        catalog.model.update(item.id, ModelV2.ID.make("gpt-5.5-pro"), () => {})
        catalog.model.update(item.id, ModelV2.ID.make("gpt-5.4-pro"), (model) => {
          model.modelID = ModelV2.ID.make("gpt-5.4")
          model.body = { reasoning: { mode: "pro" } }
        })
        catalog.model.update(item.id, ModelV2.ID.make("gpt-5.6"), () => {})
        catalog.model.update(item.id, ModelV2.ID.make("gpt-5.6-sol"), () => {})
        catalog.model.update(item.id, ModelV2.ID.make("gpt-6-astra"), () => {})
        catalog.model.update(item.id, ModelV2.ID.make("gpt-4.1"), () => {})
      })
      yield* credentials.create({
        integrationID: Integration.ID.make("openai"),
        value: Credential.OAuth.make({
          type: "oauth",
          methodID: Integration.MethodID.make("chatgpt-browser"),
          access: "chatgpt-token",
          refresh: "refresh",
          expires: Date.now() + 60_000,
          metadata: { accountID: "acct_123" },
        }),
      })
      yield* addPlugin()

      const eligible = required(yield* catalog.model.get(ProviderV2.ID.openai, ModelV2.ID.make("gpt-5.5")))
      expect(eligible.cost).toEqual([
        {
          input: Money.USDPerMillionTokens.make(1),
          output: Money.USDPerMillionTokens.make(2),
          cache: {
            read: Money.USDPerMillionTokens.make(0.1),
            write: Money.USDPerMillionTokens.zero,
          },
        },
      ])
      expect(eligible.enabled).toBe(true)
      expect(required(yield* catalog.model.get(ProviderV2.ID.openai, ModelV2.ID.make("gpt-5.5-pro"))).enabled).toBe(
        false,
      )
      expect(required(yield* catalog.model.get(ProviderV2.ID.openai, ModelV2.ID.make("gpt-5.4-pro"))).enabled).toBe(
        false,
      )
      expect(required(yield* catalog.model.get(ProviderV2.ID.openai, ModelV2.ID.make("gpt-5.6"))).enabled).toBe(false)
      expect(required(yield* catalog.model.get(ProviderV2.ID.openai, ModelV2.ID.make("gpt-5.6-sol"))).enabled).toBe(
        true,
      )
      expect(required(yield* catalog.model.get(ProviderV2.ID.openai, ModelV2.ID.make("gpt-6-astra"))).enabled).toBe(
        true,
      )
      expect(required(yield* catalog.model.get(ProviderV2.ID.openai, ModelV2.ID.make("gpt-4.1"))).enabled).toBe(false)
    }),
  )

  it.effect("keeps the full OpenAI catalog under an API key connection", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const credentials = yield* Credential.Service
      yield* catalog.transform((catalog) => {
        const item = ProviderV2.Info.make({
          ...ProviderV2.Info.empty(ProviderV2.ID.openai),
          package: ProviderV2.aisdk("@ai-sdk/openai"),
        })
        catalog.provider.update(item.id, (draft) => {
          draft.package = item.package
        })
        catalog.model.update(item.id, ModelV2.ID.make("gpt-5.5"), () => {})
        catalog.model.update(item.id, ModelV2.ID.make("gpt-4.1"), () => {})
      })
      yield* credentials.create({
        integrationID: Integration.ID.make("openai"),
        value: Credential.Key.make({ type: "key", key: "sk-test" }),
      })
      yield* addPlugin()

      expect(required(yield* catalog.model.get(ProviderV2.ID.openai, ModelV2.ID.make("gpt-5.5"))).enabled).toBe(true)
      expect(required(yield* catalog.model.get(ProviderV2.ID.openai, ModelV2.ID.make("gpt-4.1"))).enabled).toBe(true)
    }),
  )

  it.effect("does not disable gpt-5-chat-latest for non-OpenAI providers", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      yield* catalog.transform((catalog) => {
        const item = ProviderV2.Info.make({
          ...ProviderV2.Info.empty(ProviderV2.ID.make("custom-openai")),
          package: ProviderV2.aisdk("test-provider"),
        })
        catalog.provider.update(item.id, (draft) => {
          draft.package = item.package
        })
        catalog.model.update(item.id, ModelV2.ID.make("gpt-5-chat-latest"), () => {})
      })
      yield* addPlugin()
      expect(
        required(yield* catalog.model.get(ProviderV2.ID.make("custom-openai"), ModelV2.ID.make("gpt-5-chat-latest")))
          .enabled,
      ).toBe(true)
    }),
  )
})
