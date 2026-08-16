import type {
  JSONSchema7,
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider"
import { AISDK } from "@ycoding-ai/core/aisdk"
import { ModelV2 } from "@ycoding-ai/core/model"
import { ProviderV2 } from "@ycoding-ai/core/provider"
import { CacheHint, LLM, LLMError, LLMEvent, Message } from "@ycoding-ai/ai"
import { LLMClient, RequestExecutor } from "@ycoding-ai/ai/route"
import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { testEffect } from "./lib/effect"

const it = testEffect(AISDK.locationLayer)

const model = (packageName: string, settings: Record<string, unknown> = {}) =>
  ModelV2.Info.make({
    ...ModelV2.Info.empty(ProviderV2.ID.make("test-provider"), ModelV2.ID.make("catalog-model")),
    modelID: ModelV2.ID.make("api-model"),
    package: ProviderV2.aisdk(packageName),
    settings,
    limit: { context: 100, output: 20 },
  })

const streamModel = (events: ReadonlyArray<LanguageModelV3StreamPart>): LanguageModelV3 => ({
  specificationVersion: "v3",
  provider: "test",
  modelId: "test",
  supportedUrls: {},
  doGenerate: () => Promise.reject(new Error("Unexpected non-streaming request")),
  doStream: () =>
    Promise.resolve({
      stream: new ReadableStream({
        start(controller) {
          events.forEach((event) => controller.enqueue(event))
          controller.close()
        },
      }),
    }),
})

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 0, reasoning: 0 },
} as const

const client = LLMClient.layer.pipe(
  Layer.provide(
    Layer.succeed(
      RequestExecutor.Service,
      RequestExecutor.Service.of({
        execute: () => Effect.die("Unexpected HTTP request"),
      }),
    ),
  ),
)

it.effect("keys language models by package and flattened overlays", () =>
  Effect.gen(function* () {
    const aisdk = yield* AISDK.Service
    const loaded: string[] = []
    yield* aisdk.hook.sdk((event) => {
      loaded.push(event.package)
      event.sdk = { languageModel: () => ({ package: event.package }) }
    })

    const first = yield* aisdk.language(model("first", { region: "us-east-1" }))
    const second = yield* aisdk.language(model("second", { region: "us-east-1" }))
    const third = yield* aisdk.language(model("second", { region: "us-west-2" }))

    expect(first).not.toBe(second)
    expect(second).not.toBe(third)
    expect(loaded).toEqual(["first", "second", "second"])
  }),
)

it.effect("projects request settings, headers, and body overlays", () =>
  Effect.gen(function* () {
    const aisdk = yield* AISDK.Service
    let body: unknown
    yield* aisdk.hook.sdk((event) => {
      body = event.options.body
      event.sdk = {
        languageModel: () => ({ provider: event.model.providerID }),
      }
    })

    const input = model("@ai-sdk/google", {
      apiKey: "secret",
      thinkingConfig: { thinkingBudget: 1024 },
    })
    const resolved = yield* aisdk.model({
      ...input,
      headers: { "x-test": "header" },
      body: { safety_setting: "strict" },
    })
    const prepared = yield* LLMClient.prepare<LanguageModelV3CallOptions>(
      LLM.request({ model: resolved, prompt: "Hello" }),
    )

    expect(prepared.body.providerOptions).toEqual({
      google: { thinkingConfig: { thinkingBudget: 1024 } },
    })
    expect(prepared.body.headers).toEqual({ "x-test": "header" })
    expect(body).toEqual({ safety_setting: "strict" })
  }),
)

it.effect("maps pro reasoning bodies to AI SDK provider options", () =>
  Effect.gen(function* () {
    const aisdk = yield* AISDK.Service
    let body: unknown
    yield* aisdk.hook.sdk((event) => {
      body = event.options.body
      event.sdk = {
        languageModel: () => ({ provider: event.model.providerID }),
      }
    })

    const resolved = yield* aisdk.model({
      ...model("@ai-sdk/openai"),
      body: { reasoning: { mode: "pro" } },
    })
    const prepared = yield* LLMClient.prepare<LanguageModelV3CallOptions>(
      LLM.request({ model: resolved, prompt: "Hello" }),
    )

    expect(body).toBeUndefined()
    expect(prepared.body.providerOptions).toEqual({
      openai: { forceReasoning: true, reasoningMode: "pro" },
    })
  }),
)

it.effect("maps package-specific AI SDK provider option keys", () =>
  Effect.gen(function* () {
    const aisdk = yield* AISDK.Service
    yield* aisdk.hook.sdk((event) => {
      event.sdk = {
        languageModel: () => ({ provider: event.model.providerID }),
      }
    })

    const cases = [
      ["@ai-sdk/github-copilot", "copilot", { reasoningEffort: "high" }],
      ["@ai-sdk/amazon-bedrock/mantle", "openai", { reasoningEffort: "high", forceReasoning: true }],
      ["@ai-sdk/openai-compatible", "test-provider", { reasoningEffort: "high" }],
      ["@jerome-benoit/sap-ai-provider-v2", "sap-ai", { reasoningEffort: "high" }],
      ["ai-gateway-provider", "openaiCompatible", { reasoningEffort: "high" }],
    ] as const
    for (const [packageName, key, settings] of cases) {
      const resolved = yield* aisdk.model(model(packageName, { reasoningEffort: "high" }))
      const prepared = yield* LLMClient.prepare<LanguageModelV3CallOptions>(
        LLM.request({ model: resolved, prompt: "Hello" }),
      )
      expect(prepared.body.providerOptions).toEqual({ [key]: settings })
    }
  }),
)

it.effect("forces reasoning and projects both Azure AI SDK namespaces", () =>
  Effect.gen(function* () {
    const aisdk = yield* AISDK.Service
    yield* aisdk.hook.sdk((event) => {
      event.sdk = {
        languageModel: () => ({ provider: event.model.providerID }),
      }
    })

    const openai = yield* aisdk.model(model("@ai-sdk/openai", { reasoningEffort: "high" }))
    const openaiPrepared = yield* LLMClient.prepare<LanguageModelV3CallOptions>(
      LLM.request({ model: openai, prompt: "Hello" }),
    )
    expect(openaiPrepared.body.providerOptions).toEqual({
      openai: { reasoningEffort: "high", forceReasoning: true },
    })

    const azure = yield* aisdk.model(model("@ai-sdk/azure", { reasoningEffort: "high" }))
    const azurePrepared = yield* LLMClient.prepare<LanguageModelV3CallOptions>(
      LLM.request({ model: azure, prompt: "Hello" }),
    )
    expect(azurePrepared.body.providerOptions).toEqual({
      openai: { reasoningEffort: "high", forceReasoning: true },
      azure: { reasoningEffort: "high", forceReasoning: true },
    })
  }),
)

it.effect("routes AI Gateway model options by upstream prefix", () =>
  Effect.gen(function* () {
    const aisdk = yield* AISDK.Service
    yield* aisdk.hook.sdk((event) => {
      event.sdk = {
        languageModel: () => ({ provider: event.model.providerID }),
      }
    })

    const anthropic = yield* aisdk.model({
      ...model("@ai-sdk/gateway", {
        gateway: { order: ["anthropic"] },
        thinking: { type: "adaptive" },
      }),
      modelID: ModelV2.ID.make("anthropic/claude-sonnet-5"),
    })
    const anthropicPrepared = yield* LLMClient.prepare<LanguageModelV3CallOptions>(
      LLM.request({ model: anthropic, prompt: "Hello" }),
    )
    expect(anthropicPrepared.body.providerOptions).toEqual({
      gateway: { order: ["anthropic"] },
      anthropic: { thinking: { type: "adaptive" } },
    })

    const bedrock = yield* aisdk.model({
      ...model("@ai-sdk/gateway", { reasoningConfig: { type: "enabled" } }),
      modelID: ModelV2.ID.make("amazon/nova-2-lite"),
    })
    const bedrockPrepared = yield* LLMClient.prepare<LanguageModelV3CallOptions>(
      LLM.request({ model: bedrock, prompt: "Hello" }),
    )
    expect(bedrockPrepared.body.providerOptions).toEqual({
      bedrock: { reasoningConfig: { type: "enabled" } },
    })

    const fallback = yield* aisdk.model({
      ...model("@ai-sdk/gateway", { reasoningEffort: "high" }),
      modelID: ModelV2.ID.make("deepseek/deepseek-v4"),
    })
    const fallbackPrepared = yield* LLMClient.prepare<LanguageModelV3CallOptions>(
      LLM.request({ model: fallback, prompt: "Hello" }),
    )
    expect(fallbackPrepared.body.providerOptions).toEqual({
      deepseek: { reasoningEffort: "high" },
    })
  }),
)

it.effect("projects canonical cache hints onto supported AI SDK routes", () =>
  Effect.gen(function* () {
    const aisdk = yield* AISDK.Service
    yield* aisdk.hook.sdk((event) => {
      event.sdk = {
        languageModel: () => ({ provider: event.model.providerID }),
      }
    })
    const hint5m = new CacheHint({ type: "ephemeral", ttlSeconds: 300 })
    const hint1h = new CacheHint({ type: "ephemeral", ttlSeconds: 3_600 })

    const anthropic = yield* aisdk.model(model("@ai-sdk/anthropic"))
    const anthropicPrepared = yield* LLMClient.prepare<LanguageModelV3CallOptions>(
      LLM.request({
        model: anthropic,
        system: [{ type: "text", text: "stable system", cache: hint5m }],
      }),
    )
    expect(anthropicPrepared.body.prompt).toEqual([
      {
        role: "system",
        content: "stable system",
        providerOptions: {
          anthropic: { cacheControl: { type: "ephemeral", ttl: "5m" } },
        },
      },
    ])

    const openrouter = yield* aisdk.model(model("@openrouter/ai-sdk-provider"))
    const openrouterPrepared = yield* LLMClient.prepare<LanguageModelV3CallOptions>(
      LLM.request({
        model: openrouter,
        messages: [Message.user({ type: "text", text: "stable user", cache: hint1h })],
      }),
    )
    expect(openrouterPrepared.body.prompt).toEqual([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "stable user",
            providerOptions: {
              openrouter: { cacheControl: { type: "ephemeral", ttl: "1h" } },
            },
          },
        ],
      },
    ])

    const bedrock = yield* aisdk.model(model("@ai-sdk/amazon-bedrock"))
    const bedrockPrepared = yield* LLMClient.prepare<LanguageModelV3CallOptions>(
      LLM.request({
        model: bedrock,
        tools: [
          {
            name: "lookup",
            description: "Lookup data",
            inputSchema: { type: "object", properties: {} },
            cache: hint1h,
          },
        ],
      }),
    )
    expect(bedrockPrepared.body.tools).toEqual([
      {
        type: "function",
        name: "lookup",
        description: "Lookup data",
        inputSchema: { type: "object", properties: {} },
        providerOptions: {
          bedrock: { cachePoint: { type: "default", ttl: "1h" } },
        },
      },
    ])

    const generic = yield* aisdk.model(model("test-ai-sdk"))
    const genericPrepared = yield* LLMClient.prepare<LanguageModelV3CallOptions>(
      LLM.request({
        model: generic,
        messages: [
          Message.user({
            type: "text",
            text: "uncached route",
            cache: hint5m,
          }),
        ],
      }),
    )
    expect(genericPrepared.body.prompt).toEqual([{ role: "user", content: [{ type: "text", text: "uncached route" }] }])
  }),
)

it.effect("applies the default prompt cache policy to Anthropic AI SDK requests", () =>
  Effect.gen(function* () {
    const aisdk = yield* AISDK.Service
    yield* aisdk.hook.sdk((event) => {
      event.sdk = {
        languageModel: () => ({ provider: event.model.providerID }),
      }
    })
    const anthropic = yield* aisdk.model(model("@ai-sdk/anthropic"))
    const prepared = yield* LLMClient.prepare<LanguageModelV3CallOptions>(
      LLM.request({
        model: anthropic,
        system: [{ type: "text", text: "stable system" }],
        messages: [Message.user("latest prompt")],
        tools: [
          {
            name: "lookup",
            description: "Lookup data",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      }),
    )

    expect(prepared.body.tools?.[0]).toMatchObject({
      type: "function",
      name: "lookup",
      providerOptions: {
        anthropic: { cacheControl: { type: "ephemeral", ttl: "5m" } },
      },
    })
    expect(prepared.body.prompt).toEqual([
      {
        role: "system",
        content: "stable system",
        providerOptions: {
          anthropic: { cacheControl: { type: "ephemeral", ttl: "5m" } },
        },
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "latest prompt",
            providerOptions: {
              anthropic: { cacheControl: { type: "ephemeral", ttl: "5m" } },
            },
          },
        ],
      },
    ])
  }),
)

it.effect("rolls both message cache breakpoints on the Anthropic AI SDK route", () =>
  Effect.gen(function* () {
    const aisdk = yield* AISDK.Service
    yield* aisdk.hook.sdk((event) => {
      event.sdk = {
        languageModel: () => ({ provider: event.model.providerID }),
      }
    })
    const anthropic = yield* aisdk.model(model("@ai-sdk/anthropic"))
    const prepared = yield* LLMClient.prepare<LanguageModelV3CallOptions>(
      LLM.request({
        model: anthropic,
        messages: [Message.user("first"), Message.assistant("reply"), Message.user("latest")],
      }),
    )

    // The two most recent cacheable messages are anchored so the older marker
    // stays inside the provider's 20-block lookback.
    const rolling = { anthropic: { cacheControl: { type: "ephemeral", ttl: "5m" } } }
    expect(prepared.body.prompt).toEqual([
      { role: "user", content: [{ type: "text", text: "first" }] },
      { role: "assistant", content: [{ type: "text", text: "reply", providerOptions: rolling }] },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "latest",
            providerOptions: rolling,
          },
        ],
      },
    ])
  }),
)

it.effect("applies the default prompt cache policy to every cache-capable AI SDK route", () =>
  Effect.gen(function* () {
    const aisdk = yield* AISDK.Service
    yield* aisdk.hook.sdk((event) => {
      event.sdk = {
        languageModel: () => ({ provider: event.model.providerID }),
      }
    })

    const routes = [
      ["@ai-sdk/google-vertex/anthropic", { anthropic: { cacheControl: { type: "ephemeral", ttl: "5m" } } }],
      ["@openrouter/ai-sdk-provider", { openrouter: { cacheControl: { type: "ephemeral", ttl: "5m" } } }],
      ["@ai-sdk/amazon-bedrock", { bedrock: { cachePoint: { type: "default", ttl: "5m" } } }],
    ] as const

    for (const [packageName, providerOptions] of routes) {
      const resolved = yield* aisdk.model(model(packageName))
      const prepared = yield* LLMClient.prepare<LanguageModelV3CallOptions>(
        LLM.request({
          model: resolved,
          system: [{ type: "text", text: "stable system" }],
          messages: [Message.user("latest prompt")],
          tools: [
            {
              name: "lookup",
              description: "Lookup data",
              inputSchema: { type: "object", properties: {} },
            },
          ],
        }),
      )

      expect(prepared.body.tools?.[0]).toMatchObject({
        name: "lookup",
        providerOptions,
      })
      expect(prepared.body.prompt[0]).toMatchObject({
        role: "system",
        providerOptions,
      })
      expect(prepared.body.prompt[1]).toMatchObject({
        role: "user",
        content: [{ type: "text", text: "latest prompt", providerOptions }],
      })
    }
  }),
)

it.effect("projects Anthropic tool unions by route or Claude model identity", () =>
  Effect.gen(function* () {
    const aisdk = yield* AISDK.Service
    yield* aisdk.hook.sdk((event) => {
      event.sdk = {
        languageModel: () => ({ provider: event.model.providerID }),
      }
    })
    const anyOf: NonNullable<JSONSchema7["anyOf"]> = [
      {
        type: "object",
        properties: { action: { type: "string", enum: ["list"] } },
        required: ["action"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          action: { type: "string", enum: ["send"] },
          text: { type: "string" },
        },
        required: ["action", "text"],
        additionalProperties: false,
      },
    ]

    for (const [packageName, modelID] of [
      ["@ai-sdk/anthropic", "claude-opus-5"],
      ["@ai-sdk/google-vertex/anthropic", "claude-fable-5"],
      ["@openrouter/ai-sdk-provider", "anthropic/claude-opus-5"],
      ["@ai-sdk/anthropic", "gateway-opus-alias"],
    ] as const) {
      const resolved = yield* aisdk.model(
        ModelV2.Info.make({
          ...model(packageName),
          modelID: ModelV2.ID.make(modelID),
        }),
      )
      const prepared = yield* LLMClient.prepare<LanguageModelV3CallOptions>(
        LLM.request({
          model: resolved,
          prompt: "Use the tool.",
          tools: [
            {
              name: "subagent_control",
              description: "Control subagents.",
              inputSchema: { anyOf },
            },
          ],
        }),
      )

      const tool = prepared.body.tools?.[0]
      expect(tool?.type).toBe("function")
      if (tool?.type !== "function") throw new Error("Expected function tool")
      expect(tool.inputSchema).toEqual({
        type: "object",
        $ref: "#/$defs/__ycoding_root",
        $defs: { __ycoding_root: { type: "object", anyOf } },
      })
    }
  }),
)

it.effect("merges AI SDK cache hints with replay metadata", () =>
  Effect.gen(function* () {
    const aisdk = yield* AISDK.Service
    yield* aisdk.hook.sdk((event) => {
      event.sdk = {
        languageModel: () => ({ provider: event.model.providerID }),
      }
    })

    const resolved = yield* aisdk.model(model("@ai-sdk/anthropic"))
    const prepared = yield* LLMClient.prepare<LanguageModelV3CallOptions>(
      LLM.request({
        model: resolved,
        messages: [
          Message.assistant({
            type: "text",
            text: "answer",
            cache: new CacheHint({ type: "ephemeral", ttlSeconds: 300 }),
            providerMetadata: { anthropic: { signature: "signed" } },
          }),
        ],
      }),
    )

    expect(prepared.body.prompt).toEqual([
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "answer",
            providerOptions: {
              anthropic: {
                signature: "signed",
                cacheControl: { type: "ephemeral", ttl: "5m" },
              },
            },
          },
        ],
      },
    ])
  }),
)

it.effect("projects replay metadata onto AI SDK prompt parts", () =>
  Effect.gen(function* () {
    const aisdk = yield* AISDK.Service
    yield* aisdk.hook.sdk((event) => {
      event.sdk = {
        languageModel: () => ({ provider: event.model.providerID }),
      }
    })

    const resolved = yield* aisdk.model(model("@ai-sdk/anthropic"))
    expect(resolved.route.providerMetadataKey).toBe("anthropic")
    const prepared = yield* LLMClient.prepare<LanguageModelV3CallOptions>(
      LLM.request({
        model: resolved,
        messages: [
          Message.assistant([
            {
              type: "reasoning",
              text: "Think",
              providerMetadata: { anthropic: { signature: "signed" } },
            },
            {
              type: "tool-call",
              id: "hosted",
              name: "web_search",
              input: { query: "Effect" },
              providerExecuted: true,
              providerMetadata: { anthropic: { blockType: "server_tool_use" } },
            },
          ]),
        ],
      }),
    )

    expect(prepared.body.prompt).toEqual([
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "Think",
            providerOptions: { anthropic: { signature: "signed" } },
          },
          {
            type: "tool-call",
            toolCallId: "hosted",
            toolName: "web_search",
            input: { query: "Effect" },
            providerExecuted: true,
            providerOptions: { anthropic: { blockType: "server_tool_use" } },
          },
        ],
      },
    ])
  }),
)

it.effect("wraps unsupported Anthropic chronological system updates as user content", () =>
  Effect.gen(function* () {
    const aisdk = yield* AISDK.Service
    yield* aisdk.hook.sdk((event) => {
      event.sdk = {
        languageModel: () => ({ provider: event.model.providerID }),
      }
    })
    const catalog = ModelV2.Info.make({
      ...model("@ai-sdk/anthropic"),
      modelID: ModelV2.ID.make("claude-sonnet-4-6"),
    })
    const resolved = yield* aisdk.model(catalog)
    const prepared = yield* LLMClient.prepare<LanguageModelV3CallOptions>(
      LLM.request({
        model: resolved,
        cache: "none",
        messages: [
          Message.user("before"),
          Message.assistant([{ type: "text", text: "answer" }]),
          Message.system("late <update>"),
          Message.user("after"),
        ],
      }),
    )

    expect(prepared.body.prompt).toEqual([
      { role: "user", content: [{ type: "text", text: "before" }] },
      { role: "assistant", content: [{ type: "text", text: "answer" }] },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "<system-update>\nlate &lt;update&gt;\n</system-update>",
          },
        ],
      },
      { role: "user", content: [{ type: "text", text: "after" }] },
    ])
  }),
)

it.effect("preserves valid Opus 4.8 chronological system updates", () =>
  Effect.gen(function* () {
    const aisdk = yield* AISDK.Service
    yield* aisdk.hook.sdk((event) => {
      event.sdk = {
        languageModel: () => ({ provider: event.model.providerID }),
      }
    })
    const catalog = ModelV2.Info.make({
      ...model("@ai-sdk/anthropic"),
      modelID: ModelV2.ID.make("claude-opus-4-8"),
    })
    const resolved = yield* aisdk.model(catalog)
    const prepared = yield* LLMClient.prepare<LanguageModelV3CallOptions>(
      LLM.request({
        model: resolved,
        cache: "none",
        messages: [
          Message.user("question"),
          Message.system("updated instruction"),
          Message.assistant([{ type: "text", text: "answer" }]),
        ],
      }),
    )

    expect(prepared.body.prompt).toEqual([
      { role: "user", content: [{ type: "text", text: "question" }] },
      { role: "system", content: "updated instruction" },
      { role: "assistant", content: [{ type: "text", text: "answer" }] },
    ])
  }),
)

it.effect("preserves valid Claude 5 chronological system updates", () =>
  Effect.gen(function* () {
    const aisdk = yield* AISDK.Service
    yield* aisdk.hook.sdk((event) => {
      event.sdk = {
        languageModel: () => ({ provider: event.model.providerID }),
      }
    })

    for (const [packageName, modelID] of [
      ["@ai-sdk/anthropic", "claude-opus-5"],
      ["@ai-sdk/anthropic", "claude-fable-5"],
      ["@ai-sdk/google-vertex/anthropic", "claude-fable-5"],
    ] as const) {
      const resolved = yield* aisdk.model(
        ModelV2.Info.make({
          ...model(packageName),
          modelID: ModelV2.ID.make(modelID),
        }),
      )
      const prepared = yield* LLMClient.prepare<LanguageModelV3CallOptions>(
        LLM.request({
          model: resolved,
          cache: "none",
          messages: [
            Message.user("question"),
            Message.system("updated instruction"),
            Message.assistant([{ type: "text", text: "answer" }]),
          ],
        }),
      )

      expect(prepared.body.prompt).toEqual([
        { role: "user", content: [{ type: "text", text: "question" }] },
        { role: "system", content: "updated instruction" },
        { role: "assistant", content: [{ type: "text", text: "answer" }] },
      ])
    }
  }),
)

it.effect("emits malformed AI SDK tool input without executing it", () =>
  Effect.gen(function* () {
    const aisdk = yield* AISDK.Service
    const raw = '{"query":"partial'
    yield* aisdk.hook.sdk((event) => {
      event.sdk = {
        languageModel: () =>
          streamModel([
            { type: "tool-input-start", id: "call_1", toolName: "lookup" },
            { type: "tool-input-delta", id: "call_1", delta: raw },
            { type: "tool-input-end", id: "call_1" },
            {
              type: "tool-call",
              toolCallId: "call_1",
              toolName: "lookup",
              input: raw,
            },
            {
              type: "finish",
              finishReason: { unified: "tool-calls", raw: "tool_calls" },
              usage,
            },
          ]),
      }
    })

    const resolved = yield* aisdk.model(model("test-ai-sdk"))
    const response = yield* LLMClient.generate(LLM.request({ model: resolved, prompt: "Lookup" })).pipe(
      Effect.provide(client),
    )

    expect(response.events.find(LLMEvent.is.toolInputError)).toMatchObject({
      id: "call_1",
      name: "lookup",
      raw,
    })
    expect(response.events.some(LLMEvent.is.toolInputEnd)).toBeTrue()
    expect(response.events.some(LLMEvent.is.toolCall)).toBeFalse()
  }),
)

it.effect("keeps malformed provider-executed AI SDK input terminal", () =>
  Effect.gen(function* () {
    const aisdk = yield* AISDK.Service
    const raw = '{"query":"partial'
    yield* aisdk.hook.sdk((event) => {
      event.sdk = {
        languageModel: () =>
          streamModel([
            {
              type: "tool-input-start",
              id: "call_1",
              toolName: "web_search",
              providerExecuted: true,
            },
            { type: "tool-input-delta", id: "call_1", delta: raw },
            { type: "tool-input-end", id: "call_1" },
            {
              type: "tool-call",
              toolCallId: "call_1",
              toolName: "web_search",
              input: raw,
              providerExecuted: true,
            },
          ]),
      }
    })

    const resolved = yield* aisdk.model(model("hosted-test-ai-sdk"))
    const error = yield* LLMClient.generate(LLM.request({ model: resolved, prompt: "Search" })).pipe(
      Effect.provide(client),
      Effect.flip,
    )

    expect(error).toBeInstanceOf(LLMError)
    expect(error.message).toContain("Invalid JSON input for aisdk tool call web_search")
  }),
)

it.effect("preserves and sanitizes structured AI SDK provider errors", () =>
  Effect.gen(function* () {
    const aisdk = yield* AISDK.Service
    const failure = Object.assign(new Error("Error"), {
      statusCode: 400,
      url: "https://api.anthropic.com/v1/messages?key=secret-query",
      responseHeaders: {
        "content-type": "application/json",
        "x-request-id": "req_test",
        "set-cookie": "session=secret-cookie",
      },
      responseBody: JSON.stringify({
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "tools.8.custom.input_schema.type: Field required",
          access_token: "secret-response-token",
          detail: "must-never-be-retained",
        },
      }),
      requestBodyValues: { apiKey: "must-never-be-retained" },
    })
    yield* aisdk.hook.sdk((event) => {
      event.sdk = {
        languageModel: () => ({
          specificationVersion: "v3",
          provider: "anthropic",
          modelId: "claude-opus-5",
          supportedUrls: {},
          doGenerate: () => Promise.reject(new Error("Unexpected non-streaming request")),
          doStream: () => Promise.reject(failure),
        }),
      }
    })

    const resolved = yield* aisdk.model(model("@ai-sdk/anthropic"))
    const error = yield* LLMClient.generate(LLM.request({ model: resolved, prompt: "Hello" })).pipe(
      Effect.provide(client),
      Effect.flip,
    )

    expect(error).toBeInstanceOf(LLMError)
    expect(error.reason).toMatchObject({
      _tag: "InvalidRequest",
      message: "tools.8.custom.input_schema.type: Field required",
      http: {
        request: {
          method: "POST",
          url: "https://api.anthropic.com/v1/messages?key=%3Credacted%3E",
          headers: {},
        },
        response: {
          status: 400,
          headers: {
            "content-type": "application/json",
            "x-request-id": "req_test",
            "set-cookie": "<redacted>",
          },
        },
        requestId: "req_test",
      },
    })
    if (error.reason._tag !== "InvalidRequest") throw new Error(`Expected InvalidRequest, got ${error.reason._tag}`)
    expect(error.reason.http?.body).toContain('"access_token":"<redacted>"')
    expect(JSON.stringify(error)).not.toContain("secret-query")
    expect(JSON.stringify(error)).not.toContain("secret-cookie")
    expect(JSON.stringify(error)).not.toContain("secret-response-token")
    expect(JSON.stringify(error)).not.toContain("must-never-be-retained")
  }),
)

it.effect("uses a provider error code when the AI SDK message is generic", () =>
  Effect.gen(function* () {
    const aisdk = yield* AISDK.Service
    const failure = Object.assign(new Error("Error"), {
      statusCode: 429,
      url: "https://api.anthropic.com/v1/messages",
      responseHeaders: { "content-type": "application/json" },
      responseBody: JSON.stringify({
        type: "error",
        error: { type: "rate_limit_error", message: "Error" },
      }),
    })
    yield* aisdk.hook.sdk((event) => {
      event.sdk = {
        languageModel: () => ({
          specificationVersion: "v3",
          provider: "anthropic",
          modelId: "claude-opus-5",
          supportedUrls: {},
          doGenerate: () => Promise.reject(new Error("Unexpected non-streaming request")),
          doStream: () => Promise.reject(failure),
        }),
      }
    })

    const resolved = yield* aisdk.model(model("@ai-sdk/anthropic"))
    const error = yield* LLMClient.generate(LLM.request({ model: resolved, prompt: "Hello" })).pipe(
      Effect.provide(client),
      Effect.flip,
    )

    expect(error.reason).toMatchObject({
      _tag: "RateLimit",
      message: "Provider reported rate_limit_error",
    })
  }),
)

it.effect("surfaces Anthropic subscription rate-limit headers on the AI SDK path", () =>
  Effect.gen(function* () {
    const aisdk = yield* AISDK.Service
    const failure = Object.assign(new Error("Error"), {
      statusCode: 429,
      url: "https://api.anthropic.com/v1/messages",
      responseHeaders: {
        "content-type": "application/json",
        "retry-after": "90",
        "anthropic-ratelimit-unified-5h-limit": "100",
        "anthropic-ratelimit-unified-5h-remaining": "0",
        "anthropic-ratelimit-unified-5h-reset": "2026-07-25T18:00:00Z",
      },
      responseBody: JSON.stringify({
        type: "error",
        error: { type: "rate_limit_error", message: "Error" },
      }),
    })
    yield* aisdk.hook.sdk((event) => {
      event.sdk = {
        languageModel: () => ({
          specificationVersion: "v3",
          provider: "anthropic",
          modelId: "claude-opus-5",
          supportedUrls: {},
          doGenerate: () => Promise.reject(new Error("Unexpected non-streaming request")),
          doStream: () => Promise.reject(failure),
        }),
      }
    })

    const resolved = yield* aisdk.model(model("@ai-sdk/anthropic"))
    const error = yield* LLMClient.generate(LLM.request({ model: resolved, prompt: "Hello" })).pipe(
      Effect.provide(client),
      Effect.flip,
    )

    expect(error.reason).toMatchObject({
      _tag: "RateLimit",
      message:
        "Provider reported rate_limit_error (Claude subscription usage limit reached; retry after 90s; unified-5h resets at 2026-07-25T18:00:00Z)",
      retryAfterMs: 90_000,
    })
    if (error.reason._tag !== "RateLimit") throw new Error(`Expected RateLimit, got ${error.reason._tag}`)
    expect(error.reason.rateLimit).toMatchObject({
      retryAfterMs: 90_000,
      limit: { "unified-5h": "100" },
      remaining: { "unified-5h": "0" },
      reset: { "unified-5h": "2026-07-25T18:00:00Z" },
    })
    expect(error.reason.http?.rateLimit).toMatchObject({
      retryAfterMs: 90_000,
    })
  }),
)

it.effect("explains an empty-bodied 429 from rate-limit headers alone", () =>
  Effect.gen(function* () {
    const aisdk = yield* AISDK.Service
    const failure = Object.assign(new Error("Error"), {
      statusCode: 429,
      url: "https://api.anthropic.com/v1/messages",
      responseHeaders: {
        "retry-after-ms": "45000",
        "anthropic-ratelimit-requests-reset": "2026-07-25T18:00:00Z",
        authorization: "Bearer secret-oauth-token",
      },
    })
    yield* aisdk.hook.sdk((event) => {
      event.sdk = {
        languageModel: () => ({
          specificationVersion: "v3",
          provider: "anthropic",
          modelId: "claude-opus-5",
          supportedUrls: {},
          doGenerate: () => Promise.reject(new Error("Unexpected non-streaming request")),
          doStream: () => Promise.reject(failure),
        }),
      }
    })

    const resolved = yield* aisdk.model(model("@ai-sdk/anthropic"))
    const error = yield* LLMClient.generate(LLM.request({ model: resolved, prompt: "Hello" })).pipe(
      Effect.provide(client),
      Effect.flip,
    )

    expect(error.reason).toMatchObject({
      _tag: "RateLimit",
      message: "Provider request failed with HTTP 429 (retry after 45s; requests resets at 2026-07-25T18:00:00Z)",
      retryAfterMs: 45_000,
    })
    expect(JSON.stringify(error)).not.toContain("secret-oauth-token")
  }),
)

it.effect("repairs overlapping AI SDK cache-write usage", () =>
  Effect.gen(function* () {
    const aisdk = yield* AISDK.Service
    yield* aisdk.hook.sdk((event) => {
      event.sdk = {
        languageModel: () =>
          streamModel([
            {
              type: "finish",
              finishReason: { unified: "stop", raw: "stop" },
              usage: {
                inputTokens: {
                  total: 2_000,
                  noCache: 2_000,
                  cacheRead: 0,
                  cacheWrite: 2_000,
                },
                outputTokens: { total: 10, text: 10, reasoning: 0 },
                raw: {},
              },
            },
          ]),
      }
    })

    const resolved = yield* aisdk.model(model("overlapping-cache-write"))
    const response = yield* LLMClient.generate(LLM.request({ model: resolved, prompt: "Hello" })).pipe(
      Effect.provide(client),
    )

    expect(response.usage).toMatchObject({
      inputTokens: 2_000,
      nonCachedInputTokens: 0,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 2_000,
    })
  }),
)

it.effect("preserves missing AI SDK cache-write telemetry", () =>
  Effect.gen(function* () {
    const aisdk = yield* AISDK.Service
    yield* aisdk.hook.sdk((event) => {
      event.sdk = {
        languageModel: () =>
          streamModel([
            {
              type: "finish",
              finishReason: { unified: "stop", raw: "stop" },
              usage: {
                inputTokens: {
                  total: 100,
                  noCache: 40,
                  cacheRead: 60,
                  cacheWrite: undefined,
                },
                outputTokens: { total: 5, text: 5, reasoning: 0 },
                raw: {},
              },
            },
          ]),
      }
    })

    const resolved = yield* aisdk.model(model("read-only-cache-usage"))
    const response = yield* LLMClient.generate(LLM.request({ model: resolved, prompt: "Hello" })).pipe(
      Effect.provide(client),
    )

    expect(response.usage).toMatchObject({
      inputTokens: 100,
      nonCachedInputTokens: 40,
      cacheReadInputTokens: 60,
    })
    expect(response.usage?.cacheWriteInputTokens).toBeUndefined()
  }),
)
