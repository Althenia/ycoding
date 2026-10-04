import { createAlibaba } from "@ai-sdk/alibaba"
import { createCohere } from "@ai-sdk/cohere"
import { createDeepInfra } from "@ai-sdk/deepinfra"
import { createGateway } from "@ai-sdk/gateway"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { createGroq } from "@ai-sdk/groq"
import { createMistral } from "@ai-sdk/mistral"
import { createPerplexity } from "@ai-sdk/perplexity"
import { createTogetherAI } from "@ai-sdk/togetherai"
import { createVercel } from "@ai-sdk/vercel"
import { createXai } from "@ai-sdk/xai"
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { createVenice } from "venice-ai-sdk-provider"
import { AISDK } from "@ycoding-ai/core/aisdk"
import { ModelV2 } from "@ycoding-ai/core/model"
import { PluginV2 } from "@ycoding-ai/core/plugin"
import { PluginHost } from "@ycoding-ai/core/plugin/host"
import { AlibabaPlugin } from "@ycoding-ai/core/plugin/provider/alibaba"
import { CoherePlugin } from "@ycoding-ai/core/plugin/provider/cohere"
import { DeepInfraPlugin } from "@ycoding-ai/core/plugin/provider/deepinfra"
import { GatewayPlugin } from "@ycoding-ai/core/plugin/provider/gateway"
import { GooglePlugin } from "@ycoding-ai/core/plugin/provider/google"
import { GroqPlugin } from "@ycoding-ai/core/plugin/provider/groq"
import { MistralPlugin } from "@ycoding-ai/core/plugin/provider/mistral"
import { PerplexityPlugin } from "@ycoding-ai/core/plugin/provider/perplexity"
import { TogetherAIPlugin } from "@ycoding-ai/core/plugin/provider/togetherai"
import { VenicePlugin } from "@ycoding-ai/core/plugin/provider/venice"
import { VercelPlugin } from "@ycoding-ai/core/plugin/provider/vercel"
import { XAIPlugin } from "@ycoding-ai/core/plugin/provider/xai"
import { ProviderV2 } from "@ycoding-ai/core/provider"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

const bundled = [
  { plugin: AlibabaPlugin, pkg: "@ai-sdk/alibaba", create: createAlibaba },
  { plugin: CoherePlugin, pkg: "@ai-sdk/cohere", create: createCohere },
  { plugin: DeepInfraPlugin, pkg: "@ai-sdk/deepinfra", create: createDeepInfra },
  { plugin: GatewayPlugin, pkg: "@ai-sdk/gateway", create: createGateway },
  { plugin: GooglePlugin, pkg: "@ai-sdk/google", create: createGoogleGenerativeAI },
  { plugin: GroqPlugin, pkg: "@ai-sdk/groq", create: createGroq },
  { plugin: MistralPlugin, pkg: "@ai-sdk/mistral", create: createMistral },
  { plugin: PerplexityPlugin, pkg: "@ai-sdk/perplexity", create: createPerplexity },
  { plugin: TogetherAIPlugin, pkg: "@ai-sdk/togetherai", create: createTogetherAI },
  { plugin: VenicePlugin, pkg: "venice-ai-sdk-provider", create: createVenice },
  { plugin: VercelPlugin, pkg: "@ai-sdk/vercel", create: createVercel },
  { plugin: XAIPlugin, pkg: "@ai-sdk/xai", create: createXai },
] as const

const apiKey = "bundled-provider-key"

const runSDK = Effect.fn(function* (
  pkg: string,
  name: string,
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
) {
  const aisdk = yield* AISDK.Service
  return yield* aisdk.runSDK({
    model: ModelV2.Info.make({
      ...ModelV2.Info.empty(ProviderV2.ID.make(name), ModelV2.ID.make("model")),
      modelID: ModelV2.ID.make("model"),
      package: `aisdk:${pkg}`,
    }),
    package: pkg,
    options: { name, apiKey, fetch },
  })
})

const addPlugin = Effect.fn(function* (plugin: (typeof bundled)[number]["plugin"]) {
  yield* plugin.effect(yield* PluginHost.make(yield* PluginV2.Service))
})

describe("bundled AI SDK provider plugins", () => {
  for (const entry of bundled) {
    it.effect(`${entry.plugin.id} creates the SDK for its exact package with canonical and custom provider IDs and credentials`, () =>
      Effect.gen(function* () {
        yield* addPlugin(entry.plugin)
        for (const name of [entry.plugin.id.replace("ycoding.provider.", ""), "custom-provider"]) {
          const sent: string[][] = []
          const result = yield* runSDK(entry.pkg, name, (_url, init) => {
            sent.push(Array.from(new Headers(init?.headers).values()))
            return Promise.reject(new Error("request captured"))
          })
          const expected = (entry.create as (options: object) => {
            languageModel: (id: string) => { provider: string; modelId: string }
          })({ name, apiKey })
          const language = result.sdk?.languageModel("model")
          expect(language).toMatchObject({
            provider: expected.languageModel("model").provider,
            modelId: expected.languageModel("model").modelId,
          })
          yield* Effect.promise(() =>
            language
              .doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }] })
              .catch(() => undefined),
          )
          expect(sent).toHaveLength(1)
          expect(sent[0]?.some((value) => value.includes(apiKey))).toBe(true)
        }
      }),
    )

    it.effect(`${entry.plugin.id} ignores other and lookalike packages`, () =>
      Effect.gen(function* () {
        yield* addPlugin(entry.plugin)
        for (const pkg of [
          "@ai-sdk/openai-compatible",
          `${entry.pkg}/compat`,
          `${entry.pkg}-lookalike`,
          `file:///tmp/${entry.pkg}.js`,
        ]) {
          expect((yield* runSDK(pkg, "custom-provider")).sdk).toBeUndefined()
        }
      }),
    )
  }
})
