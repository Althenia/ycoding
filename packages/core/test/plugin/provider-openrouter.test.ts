import type { LanguageModelV3CallOptions } from "@ai-sdk/provider"
import { LLM } from "@ycoding-ai/ai"
import { LLMClient } from "@ycoding-ai/ai/route"
import { AISDK } from "@ycoding-ai/core/aisdk"
import { Credential } from "@ycoding-ai/core/credential"
import { Integration } from "@ycoding-ai/core/integration"
import { SessionRunnerModel } from "@ycoding-ai/core/session/runner/model"
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Catalog } from "@ycoding-ai/core/catalog"
import { ModelV2 } from "@ycoding-ai/core/model"
import { PluginV2 } from "@ycoding-ai/core/plugin"
import { PluginHost } from "@ycoding-ai/core/plugin/host"
import { ProviderPlugins } from "@ycoding-ai/core/plugin/provider"
import { OpenRouterPlugin } from "@ycoding-ai/core/plugin/provider/openrouter"
import { ProviderV2 } from "@ycoding-ai/core/provider"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

const addPlugin = Effect.fn(function* () {
  const plugin = yield* PluginV2.Service
  const aisdk = yield* AISDK.Service
  const host = yield* PluginHost.make(plugin)
  yield* OpenRouterPlugin.effect(host)
})

describe("OpenRouterPlugin", () => {
  it.effect("is registered so legacy OpenRouter behavior can be applied", () =>
    Effect.sync(() => expect(ProviderPlugins.map((item) => item.id)).toContain("ycoding.provider.openrouter")),
  )

  it.effect("applies OpenRouter app-attribution and legacy title headers only to openrouter", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      yield* catalog.transform((catalog) => {
        catalog.provider.update(ProviderV2.ID.openrouter, (provider) => {
          provider.package = ProviderV2.aisdk("@openrouter/ai-sdk-provider")
          provider.headers = { Existing: "value" }
        })
        catalog.provider.update(ProviderV2.ID.make("nvidia"), () => {})
      })
      yield* addPlugin()

      expect((yield* catalog.provider.get(ProviderV2.ID.openrouter))?.headers).toEqual({
        Existing: "value",
        "HTTP-Referer": "https://github.com/Althenia/ycoding",
        "X-OpenRouter-Title": "YCoding",
        "X-OpenRouter-Categories": "cli-agent",
        "X-Title": "YCoding",
      })
      expect((yield* catalog.provider.get(ProviderV2.ID.make("nvidia")))?.headers).toBeUndefined()
    }),
  )

  it.effect("preserves user-configured OpenRouter app-attribution headers", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      yield* catalog.transform((catalog) => {
        catalog.provider.update(ProviderV2.ID.openrouter, (provider) => {
          provider.package = ProviderV2.aisdk("@openrouter/ai-sdk-provider")
          provider.headers = {
            Other: "kept",
            "HTTP-Referer": "https://user.example/app",
            "X-OpenRouter-Title": "MyApp",
            "X-OpenRouter-Categories": "web",
          }
        })
      })
      yield* addPlugin()

      expect((yield* catalog.provider.get(ProviderV2.ID.openrouter))?.headers).toEqual({
        Other: "kept",
        "HTTP-Referer": "https://user.example/app",
        "X-OpenRouter-Title": "MyApp",
        "X-OpenRouter-Categories": "web",
        "X-Title": "YCoding",
      })
    }),
  )

  it.effect("does not add app-attribution headers to kilo", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      yield* catalog.transform((catalog) => {
        catalog.provider.update(ProviderV2.ID.make("kilo"), (provider) => {
          provider.package = ProviderV2.aisdk("@ai-sdk/openai-compatible")
          provider.settings = { baseURL: "https://api.kilo.ai/api/gateway" }
          provider.headers = { Existing: "value" }
        })
      })
      yield* addPlugin()

      const headers = (yield* catalog.provider.get(ProviderV2.ID.make("kilo")))?.headers
      expect(headers).toEqual({ Existing: "value" })
      expect(headers).not.toHaveProperty("http-referer")
      expect(headers).not.toHaveProperty("x-title")
    }),
  )

  it.effect("creates an SDK only for the OpenRouter package", () =>
    Effect.gen(function* () {
      const plugin = yield* PluginV2.Service
      const aisdk = yield* AISDK.Service
      yield* addPlugin()

      const ignored = yield* aisdk.runSDK({
        model: ModelV2.Info.make({
          ...ModelV2.Info.empty(ProviderV2.ID.openrouter, ModelV2.ID.make("openai/gpt-5")),
          modelID: ModelV2.ID.make("openai/gpt-5"),
          package: ProviderV2.aisdk("test-provider"),
        }),
        package: "@ai-sdk/openai-compatible",
        options: { name: "openrouter" },
      })
      expect(ignored.sdk).toBeUndefined()

      const result = yield* aisdk.runSDK({
        model: ModelV2.Info.make({
          ...ModelV2.Info.empty(ProviderV2.ID.make("custom"), ModelV2.ID.make("openai/gpt-5")),
          modelID: ModelV2.ID.make("openai/gpt-5"),
          package: ProviderV2.aisdk("test-provider"),
        }),
        package: "@openrouter/ai-sdk-provider",
        options: { name: "custom" },
      })
      expect(result.sdk).toBeDefined()
    }),
  )

  it.effect("sends a stored API key on the actual OpenRouter request", () =>
    Effect.gen(function* () {
      const aisdk = yield* AISDK.Service
      const integrations = yield* Integration.Service
      const integrationID = Integration.ID.make("openrouter")
      yield* integrations.transform((editor) =>
        editor.method.update({ integrationID, method: { type: "key", label: "API key" } }),
      )
      yield* integrations.connection.key({ integrationID, key: "stored-openrouter-key" })
      const connection = yield* integrations.connection.active(integrationID)
      if (!connection) throw new Error("Stored OpenRouter connection was not active")
      const credential = yield* integrations.connection.resolve(connection)
      expect(credential).toEqual(Credential.Key.make({ type: "key", key: "stored-openrouter-key" }))

      let authorization: string | null | undefined
      const request = Object.assign(
        async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          authorization = new Headers(init?.headers).get("authorization")
          return Response.json({
            id: "generation-1",
            object: "chat.completion",
            created: 0,
            model: "openai/gpt-4o-mini",
            choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          })
        },
        { preconnect: fetch.preconnect },
      )
      yield* aisdk.hook.sdk((event) => {
        if (event.package === "@openrouter/ai-sdk-provider") event.options.fetch = request
      })
      yield* addPlugin()

      let runtime: ModelV2.Info | undefined
      yield* SessionRunnerModel.fromCatalogModel(
        ModelV2.Info.make({
          ...ModelV2.Info.empty(ProviderV2.ID.openrouter, ModelV2.ID.make("openai/gpt-4o-mini")),
          modelID: ModelV2.ID.make("openai/gpt-4o-mini"),
          package: ProviderV2.aisdk("@openrouter/ai-sdk-provider"),
          headers: { Authorization: "" },
          capabilities: { tools: true, input: ["text"], output: ["text"] },
          limit: { context: 128_000, output: 16_384 },
        }),
        credential,
        {
          loadAISDK: (model) =>
            Effect.gen(function* () {
              runtime = model
              return yield* aisdk.model(model)
            }),
        },
      )
      if (!runtime) throw new Error("OpenRouter runtime model was not resolved")
      const language = yield* aisdk.language(runtime)
      yield* Effect.tryPromise(() =>
        language.doGenerate({
          prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
        }),
      )

      expect(authorization).toBe("Bearer stored-openrouter-key")
    }),
  )

  it.effect("filters OpenRouter's gpt-5 chat alias", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      yield* catalog.transform((catalog) => {
        catalog.provider.update(ProviderV2.ID.openrouter, (provider) => {
          provider.package = ProviderV2.aisdk("@openrouter/ai-sdk-provider")
        })
        catalog.provider.update(ProviderV2.ID.openai, () => {})
        catalog.model.update(ProviderV2.ID.openrouter, ModelV2.ID.make("openai/gpt-5-chat"), () => {})
        catalog.model.update(ProviderV2.ID.openrouter, ModelV2.ID.make("openai/gpt-5"), () => {})
        catalog.model.update(ProviderV2.ID.openai, ModelV2.ID.make("openai/gpt-5-chat"), () => {})
      })
      yield* addPlugin()

      expect((yield* catalog.model.get(ProviderV2.ID.openrouter, ModelV2.ID.make("openai/gpt-5-chat")))?.enabled).toBe(
        false,
      )
      expect((yield* catalog.model.get(ProviderV2.ID.openrouter, ModelV2.ID.make("openai/gpt-5")))?.enabled).toBe(true)
      expect((yield* catalog.model.get(ProviderV2.ID.openai, ModelV2.ID.make("openai/gpt-5-chat")))?.enabled).toBe(true)
    }),
  )

  it.effect("does not disable gpt-5-chat-latest for non-OpenRouter providers", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      yield* catalog.transform((catalog) => {
        catalog.provider.update(ProviderV2.ID.make("custom-openrouter"), () => {})
        catalog.model.update(ProviderV2.ID.make("custom-openrouter"), ModelV2.ID.make("gpt-5-chat-latest"), () => {})
      })
      yield* addPlugin()
      expect(
        (yield* catalog.model.get(ProviderV2.ID.make("custom-openrouter"), ModelV2.ID.make("gpt-5-chat-latest")))
          ?.enabled,
      ).toBe(true)
    }),
  )

  it.effect("serializes Claude Opus 5 union tool schemas through OpenRouter", () =>
    Effect.gen(function* () {
      const aisdk = yield* AISDK.Service
      let body: Record<string, unknown> | undefined
      const request = Object.assign(
        async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          body = JSON.parse(await new Response(init?.body).text())
          return Response.json({
            id: "generation-opus-5-tool",
            object: "chat.completion",
            created: 0,
            model: "anthropic/claude-opus-5",
            choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          })
        },
        { preconnect: fetch.preconnect },
      )
      yield* aisdk.hook.sdk((event) => {
        if (event.package !== "@openrouter/ai-sdk-provider") return
        event.options.apiKey = "test-key"
        event.options.fetch = request
      })
      yield* addPlugin()
      const runtime = ModelV2.Info.make({
        ...ModelV2.Info.empty(ProviderV2.ID.openrouter, ModelV2.ID.make("anthropic/claude-opus-5")),
        modelID: ModelV2.ID.make("anthropic/claude-opus-5"),
        package: ProviderV2.aisdk("@openrouter/ai-sdk-provider"),
      })
      const resolved = yield* aisdk.model(runtime)
      const anyOf = [
        {
          type: "object",
          properties: { action: { type: "string", enum: ["list"] } },
          required: ["action"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: { action: { type: "string", enum: ["send"] }, text: { type: "string" } },
          required: ["action", "text"],
          additionalProperties: false,
        },
      ]
      const prepared = yield* LLMClient.prepare<LanguageModelV3CallOptions>(
        LLM.request({
          model: resolved,
          prompt: "Use the tool.",
          tools: [{ name: "subagent_control", description: "Control subagents.", inputSchema: { anyOf } }],
        }),
      )
      const language = yield* aisdk.language(runtime)
      yield* Effect.tryPromise(() => language.doGenerate(prepared.body))

      expect(body).toMatchObject({
        model: "anthropic/claude-opus-5",
        tools: [
          {
            type: "function",
            function: {
              name: "subagent_control",
              parameters: {
                type: "object",
                $ref: "#/$defs/__ycoding_root",
                $defs: { __ycoding_root: { type: "object", anyOf } },
              },
            },
          },
        ],
      })
    }),
  )

  it.effect("sends snake_case cache identity fields via the AI SDK provider", () =>
    Effect.gen(function* () {
      const aisdk = yield* AISDK.Service
      const integrations = yield* Integration.Service
      const integrationID = Integration.ID.make("openrouter")
      yield* integrations.transform((editor) =>
        editor.method.update({ integrationID, method: { type: "key", label: "API key" } }),
      )
      yield* integrations.connection.key({ integrationID, key: "test-key" })

      let body: Record<string, unknown> | undefined
      const request = Object.assign(
        async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          body = JSON.parse(await new Response(init?.body).text())
          return Response.json({
            id: "gen-1",
            object: "chat.completion",
            created: 0,
            model: "openai/gpt-4o-mini",
            choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          })
        },
        { preconnect: fetch.preconnect },
      )
      yield* aisdk.hook.sdk((event) => {
        if (event.package === "@openrouter/ai-sdk-provider") event.options.fetch = request
      })
      yield* addPlugin()

      const credential = yield* integrations.connection
        .resolve((yield* integrations.connection.active(integrationID))!)
      let runtime: ModelV2.Info | undefined
      yield* SessionRunnerModel.fromCatalogModel(
        ModelV2.Info.make({
          ...ModelV2.Info.empty(ProviderV2.ID.openrouter, ModelV2.ID.make("openai/gpt-4o-mini")),
          modelID: ModelV2.ID.make("openai/gpt-4o-mini"),
          package: ProviderV2.aisdk("@openrouter/ai-sdk-provider"),
          headers: { Authorization: "" },
          capabilities: { tools: true, input: ["text"], output: ["text"] },
          limit: { context: 128_000, output: 16_384 },
        }),
        credential,
        {
          loadAISDK: (model) =>
            Effect.gen(function* () {
              runtime = model
              return yield* aisdk.model(model)
            }),
        },
      )
      if (!runtime) throw new Error("OpenRouter runtime model was not resolved")
      const language = yield* aisdk.language(runtime)
      yield* Effect.tryPromise(() =>
        language.doGenerate({
          prompt: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: "Hello",
                  providerOptions: {
                    openrouter: { cacheControl: { type: "ephemeral", ttl: "1h" } },
                  },
                },
              ],
            },
          ],
          providerOptions: {
            openrouter: {
              prompt_cache_key: "abc123",
              session_id: "def456",
            },
          },
        }),
      )

      expect(body!).toMatchObject({
        prompt_cache_key: "abc123",
        session_id: "def456",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Hello",
                cache_control: { type: "ephemeral", ttl: "1h" },
              },
            ],
          },
        ],
      })
      expect(body!).not.toHaveProperty("promptCacheKey")
      expect(body!).not.toHaveProperty("sessionID")
    }),
  )
})
