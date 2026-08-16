import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { CacheHint, LLM, Message, Model, ToolCallPart, ToolResultPart } from "../src"
import { Auth, LLMClient } from "../src/route"
import { AmazonBedrock, GoogleVertexMessages, OpenAI, OpenRouter } from "../src/providers"
import * as AnthropicMessages from "../src/protocols/anthropic-messages"
import * as Gemini from "../src/protocols/gemini"
import * as OpenAIChat from "../src/protocols/openai-chat"
import { CACHE_POLICY_REVISION, applyCachePolicy } from "../src/cache-policy"
import { it } from "./lib/effect"

const anthropicModel = AnthropicMessages.route
  .with({
    endpoint: { baseURL: "https://api.anthropic.test/v1/" },
    auth: Auth.header("x-api-key", "test"),
  })
  .model({ id: "claude-sonnet-4-5" })

const bedrockModel = AmazonBedrock.configure({
  credentials: {
    region: "us-east-1",
    accessKeyId: "fixture",
    secretAccessKey: "fixture",
  },
}).model("anthropic.claude-3-5-sonnet-20241022-v2:0")

const vertexAnthropicModel = GoogleVertexMessages.configure({
  accessToken: "test",
  baseURL: "https://vertex.test/v1/projects/test/locations/global/publishers/anthropic/models",
}).model("claude-sonnet-4-5")

const openaiModel = OpenAIChat.route
  .with({
    endpoint: { baseURL: "https://api.openai.test/v1/" },
    auth: Auth.bearer("test"),
  })
  .model({ id: "gpt-4o-mini" })

const openai56Model = OpenAIChat.route
  .with({
    endpoint: { baseURL: "https://api.openai.test/v1/" },
    auth: Auth.bearer("test"),
  })
  .model({ id: "gpt-5.6" })

const openai56ResponsesModel = OpenAI.configure({
  baseURL: "https://api.openai.test/v1/",
  apiKey: "test",
}).model("gpt-5.6")

const geminiModel = Gemini.route
  .with({
    endpoint: { baseURL: "https://generativelanguage.test/v1beta/" },
    auth: Auth.header("x-goog-api-key", "test"),
  })
  .model({ id: "gemini-2.5-flash" })

const openrouterModel = OpenRouter.configure({ apiKey: "test" }).model("anthropic/claude-sonnet-4.5")

test("pins the provider-native cache policy revision", () => {
  expect(CACHE_POLICY_REVISION).toBe("provider-native/v7")
})

const unknownAnthropicModel = AnthropicMessages.route
  .with({
    endpoint: { baseURL: "https://anthropic-compatible.test/v1/" },
    auth: Auth.header("x-api-key", "test"),
  })
  .model({ id: "some-self-hosted-model" })

describe("auto TTL split", () => {
  it.effect("pins the static prefix to the 1h bucket and the rolling tail to 5m", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model: anthropicModel,
          system: "Sys A",
          tools: [{ name: "t1", description: "t1", inputSchema: { type: "object", properties: {} } }],
          messages: [Message.user("first user"), Message.user("latest user")],
          cache: "auto",
        }),
      )

      // tools -> system -> messages is also the TTL ordering Anthropic requires:
      // every 1h breakpoint must precede every 5m one.
      const body = prepared.body as {
        tools: ReadonlyArray<{ cache_control?: unknown }>
        system: ReadonlyArray<{ cache_control?: unknown }>
        messages: ReadonlyArray<{ content: ReadonlyArray<{ cache_control?: unknown }> }>
      }
      expect(body.tools.at(-1)?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" })
      expect(body.system.at(-1)?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" })
      expect(body.messages.at(-1)?.content.at(-1)?.cache_control).toEqual({ type: "ephemeral" })
    }),
  )

  it.effect("keeps the 5m bucket for a model with no published cache profile", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model: unknownAnthropicModel,
          system: "Sys A",
          prompt: "hi",
          cache: "auto",
        }),
      )

      const body = prepared.body as { system: ReadonlyArray<{ cache_control?: unknown }> }
      expect(body.system.at(-1)?.cache_control).toEqual({ type: "ephemeral" })
    }),
  )

  it.effect("an explicit ttlSeconds still applies uniformly", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model: anthropicModel,
          system: "Sys A",
          prompt: "hi",
          cache: { system: true, messages: { tail: 1 }, ttlSeconds: 3600 },
        }),
      )

      const body = prepared.body as {
        system: ReadonlyArray<{ cache_control?: unknown }>
        messages: ReadonlyArray<{ content: ReadonlyArray<{ cache_control?: unknown }> }>
      }
      expect(body.system.at(-1)?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" })
      expect(body.messages.at(-1)?.content.at(-1)?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" })
    }),
  )
})

describe("auto message anchors", () => {
  it.effect("anchors the two most recent cacheable messages on direct Anthropic", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model: anthropicModel,
          system: "Sys A",
          tools: [{ name: "t1", description: "t1", inputSchema: { type: "object", properties: {} } }],
          messages: [Message.user("first user"), Message.assistant("assistant reply"), Message.user("latest user")],
          cache: "auto",
        }),
      )

      // Anthropic checks at most 20 block positions per breakpoint. A single
      // trailing anchor misses whenever one turn appends more than that, so the
      // older anchor stays inside the window and the whole prefix is not re-billed.
      const body = prepared.body as {
        messages: ReadonlyArray<{ content: ReadonlyArray<{ cache_control?: unknown }> }>
      }
      expect(body.messages.map((message) => message.content.at(-1)?.cache_control)).toEqual([
        undefined,
        { type: "ephemeral" },
        { type: "ephemeral" },
      ])
    }),
  )
})

describe("applyCachePolicy", () => {
  it.effect("undefined cache resolves to 'auto' (the recommended default)", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model: anthropicModel,
          system: "You are concise.",
          prompt: "hi",
        }),
      )

      // No explicit cache field → auto policy fires → last system part + latest
      // user message both get cache_control markers.
      expect(prepared.body).toMatchObject({
        system: [
          {
            type: "text",
            text: "You are concise.",
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "hi",
                cache_control: { type: "ephemeral" },
              },
            ],
          },
        ],
      })
    }),
  )

  it.effect("'auto' marks the last tool, last system part, and latest user message on Anthropic", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model: anthropicModel,
          system: "Sys A",
          tools: [
            {
              name: "t1",
              description: "t1",
              inputSchema: { type: "object", properties: {} },
            },
          ],
          messages: [
            Message.user("first user"),
            Message.assistant("assistant reply"),
            Message.user("latest user message"),
          ],
          cache: "auto",
        }),
      )

      expect(prepared.body).toMatchObject({
        tools: [{ name: "t1", cache_control: { type: "ephemeral" } }],
        system: [
          {
            type: "text",
            text: "Sys A",
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: [
          { role: "user", content: [{ type: "text", text: "first user" }] },
          {
            role: "assistant",
            content: [{ type: "text", text: "assistant reply" }],
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "latest user message",
                cache_control: { type: "ephemeral" },
              },
            ],
          },
        ],
      })
    }),
  )

  it.effect("'auto' follows the Anthropic Messages protocol on Vertex", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model: vertexAnthropicModel,
          system: "Sys",
          prompt: "hi",
          cache: "auto",
        }),
      )

      expect(prepared.body).toMatchObject({
        system: [{ type: "text", text: "Sys", cache_control: { type: "ephemeral" } }],
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "hi",
                cache_control: { type: "ephemeral" },
              },
            ],
          },
        ],
      })
    }),
  )

  it.effect("GPT-5.6 OpenAI implicit and explicit policies both honor explicit stable-prefix breakpoints", () =>
    Effect.gen(function* () {
      const explicit = yield* LLMClient.prepare(
        LLM.request({
          model: openai56Model,
          system: "Stable system",
          prompt: "hi",
          cache: { tools: true, system: true, messages: { tail: 2 } },
          providerOptions: { openai: { promptCacheOptions: { mode: "explicit" } } },
        }),
      )
      expect(JSON.stringify(explicit.body)).toContain("prompt_cache_breakpoint")

      const implicit = yield* LLMClient.prepare(
        LLM.request({
          model: openai56Model,
          system: "Stable system",
          prompt: "hi",
          cache: { tools: true, system: true, messages: { tail: 2 } },
          providerOptions: { openai: { promptCacheOptions: { mode: "implicit" } } },
        }),
      )
      expect(JSON.stringify(implicit.body)).toContain("prompt_cache_breakpoint")

      const unsupported = yield* LLMClient.prepare(
        LLM.request({
          model: openaiModel,
          system: "Stable system",
          prompt: "hi",
          cache: { tools: true, system: true, messages: { tail: 2 } },
          providerOptions: { openai: { promptCacheOptions: { mode: "explicit" } } },
        }),
      )
      expect(JSON.stringify(unsupported.body)).not.toContain("prompt_cache_breakpoint")
    }),
  )

  test("does not apply GPT-5.6 inline cache policy to OpenAI-compatible routes", () => {
    const compatibleModel = Model.update(openai56Model, {
      route: openai56Model.route.with({ id: "openai-compatible-chat" }),
    })
    const request = LLM.request({
      model: compatibleModel,
      system: "Stable system",
      prompt: "hi",
      cache: "auto",
      providerOptions: { openai: { promptCacheOptions: { mode: "explicit", ttl: "30m" } } },
    })

    expect(applyCachePolicy(request)).toBe(request)
  })

  it.effect("preserves every GPT-5.6 marker selected by an explicit tail policy", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model: openai56Model,
          messages: [Message.user("a"), Message.user("b"), Message.user("c"), Message.user("d"), Message.user("e")],
          cache: { messages: { tail: 5 } },
          providerOptions: { openai: { promptCacheOptions: { mode: "implicit", ttl: "30m" } } },
        }),
      )

      const body = prepared.body as {
        messages: ReadonlyArray<{
          content: string | ReadonlyArray<{ text: string; prompt_cache_breakpoint?: unknown }>
        }>
      }
      expect(
        body.messages.flatMap((message) =>
          (Array.isArray(message.content) ? message.content : [])
            .filter((part) => part.prompt_cache_breakpoint !== undefined)
            .map((part) => part.text),
        ),
      ).toEqual(["a", "b", "c", "d", "e"])
    }),
  )

  test("does not inject GPT-5.6 cache hints into tool definitions", () => {
    const request = LLM.request({
      model: openai56Model,
      system: "Stable system",
      tools: [{ name: "search", description: "Search", inputSchema: { type: "object", properties: {} } }],
      prompt: "hi",
      cache: { tools: true, system: true, messages: { tail: 1 } },
      providerOptions: { openai: { promptCacheOptions: { mode: "implicit", ttl: "30m" } } },
    })

    const applied = applyCachePolicy(request)
    expect(applied.tools[0]?.cache).toBeUndefined()
    expect(applied.system[0]?.cache).toBeDefined()
    expect(applied.messages[0]?.content[0]).toMatchObject({ cache: { type: "ephemeral" } })
  })

  test("keeps GPT-5.6 system and message markers despite mixed manual TTLs", () => {
    const request = LLM.request({
      model: openai56Model,
      system: { type: "text", text: "Stable system", cache: new CacheHint({ type: "ephemeral" }) },
      prompt: "hi",
      cache: { system: true, messages: { tail: 1 }, ttlSeconds: 3600 },
      providerOptions: { openai: { promptCacheOptions: { mode: "implicit", ttl: "30m" } } },
    })

    const applied = applyCachePolicy(request)
    expect(applied.system[0]?.cache).toEqual(new CacheHint({ type: "ephemeral" }))
    expect(applied.messages[0]?.content[0]).toMatchObject({ cache: { type: "ephemeral", ttlSeconds: 3600 } })
  })

  test("marks GPT-5.6 Responses input boundaries without marking assistant output", () => {
    const request = LLM.request({
      model: openai56ResponsesModel,
      messages: [
        Message.user("older user"),
        Message.assistant("first assistant"),
        Message.tool({ id: "call_1", name: "lookup", result: "tool result" }),
        Message.user("latest user"),
        Message.assistant("tail assistant"),
      ],
      cache: { messages: { tail: Number.MAX_SAFE_INTEGER } },
      providerOptions: { openai: { promptCacheOptions: { mode: "explicit", ttl: "30m" } } },
    })

    const applied = applyCachePolicy(request)
    expect(applied.messages[0]?.content[0]).toMatchObject({ cache: { type: "ephemeral" } })
    expect(applied.messages[1]?.content[0]).not.toHaveProperty("cache")
    expect(applied.messages[3]?.content[0]).toMatchObject({ cache: { type: "ephemeral" } })
    expect(applied.messages[2]?.content[0]).toMatchObject({ cache: { type: "ephemeral" } })
    expect(applied.messages[4]?.content[0]).not.toHaveProperty("cache")
  })

  test("bounds GPT-5.6 explicit candidates while retaining the system anchor and recent rolling anchors", () => {
    const messages = Array.from({ length: 60 }, (_, index) => [
      Message.user(`user ${index}`),
      Message.assistant([ToolCallPart.make({ id: `call_${index}`, name: "lookup", input: {} })]),
      Message.tool({ id: `call_${index}`, name: "lookup", result: `result ${index}` }),
    ]).flat()
    const apply = (mode: "implicit" | "explicit") =>
      applyCachePolicy(
        LLM.request({
          model: Model.update(openai56Model, {
            route: openai56Model.route.with({ id: "openai-responses" }),
          }),
          system: "Stable system",
          messages,
          cache: { system: true, messages: { tail: 50 } },
          providerOptions: { openai: { promptCacheOptions: { mode, ttl: "30m" } } },
        }),
      )
    const marked = (request: ReturnType<typeof apply>) => [
      ...request.system.filter((part) => part.cache !== undefined).map((part) => part.text),
      ...request.messages.flatMap((message) =>
        message.content.flatMap((part) => {
          if (!("cache" in part) || !part.cache) return []
          if (part.type === "text") return [part.text]
          if (part.type === "tool-result") return [String(part.result.value)]
          return []
        }),
      ),
    ]

    const automatic = marked(apply("implicit"))
    expect(automatic).toHaveLength(49)
    expect(automatic[0]).toBe("Stable system")
    expect(automatic).toContain("user 0")
    expect(automatic).toContain("result 0")
    expect(automatic).toContain("result 59")
    expect(automatic).not.toContain("user 1")
    expect(automatic).not.toContain("result 1")

    const explicit = marked(apply("explicit"))
    expect(explicit).toHaveLength(50)
    expect(explicit[0]).toBe("Stable system")
    expect(explicit).toContain("user 0")
    expect(explicit).toContain("result 0")
    expect(explicit).toContain("result 59")
    expect(explicit).not.toContain("user 1")
  })

  test("bounds pre-marked GPT-5.6 candidates while retaining the system anchor and newest messages", () => {
    const cache = new CacheHint({ type: "ephemeral" })
    const applied = applyCachePolicy(
      LLM.request({
        model: Model.update(openai56Model, {
          route: openai56Model.route.with({ id: "openai-responses" }),
        }),
        system: { type: "text", text: "Stable system", cache },
        messages: Array.from({ length: 60 }, (_, index) =>
          Message.user([{ type: "text", text: `user ${index}`, cache }]),
        ),
        cache: "none",
        providerOptions: { openai: { promptCacheOptions: { mode: "explicit", ttl: "30m" } } },
      }),
    )
    const marked = [
      ...applied.system.filter((part) => part.cache !== undefined).map((part) => part.text),
      ...applied.messages.flatMap((message) =>
        message.content.flatMap((part) => ("cache" in part && part.cache && part.type === "text" ? [part.text] : [])),
      ),
    ]

    expect(marked).toHaveLength(50)
    expect(marked[0]).toBe("Stable system")
    expect(marked).toContain("user 0")
    expect(marked).toContain("user 1")
    expect(marked).toContain("user 59")
    expect(marked).not.toContain("user 2")
  })

  test("retains stable earliest prefix within 50 window for long mainchat history", () => {
    // Simulate 60 messages (mainchat) vs subagent short history: system + first user must stay cached
    const longMessages = Array.from({ length: 60 }, (_, i) => Message.user(`user ${i}`))
    const shortMessages = Array.from({ length: 10 }, (_, i) => Message.user(`user ${i}`))
    const mk = (msgs: typeof longMessages) =>
      applyCachePolicy(
        LLM.request({
          model: Model.update(openai56Model, { route: openai56Model.route.with({ id: "openai-responses" }) }),
          system: "Stable system",
          messages: msgs,
          cache: { system: true, messages: { tail: 50 } },
          providerOptions: { openai: { promptCacheOptions: { mode: "explicit", ttl: "30m" } } },
        }),
      )
    const longMarked = [
      ...mk(longMessages).system.filter((p) => p.cache !== undefined).map((p) => p.text),
      ...mk(longMessages).messages.flatMap((m) => m.content.flatMap((p) => ("cache" in p && p.cache && p.type === "text" ? [p.text] : []))),
    ]
    const shortMarked = [
      ...mk(shortMessages).system.filter((p) => p.cache !== undefined).map((p) => p.text),
      ...mk(shortMessages).messages.flatMap((m) => m.content.flatMap((p) => ("cache" in p && p.cache && p.type === "text" ? [p.text] : []))),
    ]
    // Long history must still contain system and first two users within 50 window (stable prefix exceeds 1024-token minimum)
    expect(longMarked).toContain("Stable system")
    expect(longMarked).toContain("user 0")
    expect(longMarked).toContain("user 1")
    expect(longMarked).toContain("user 59")
    expect(longMarked).not.toContain("user 2")
    // Short history retains all without eviction
    expect(shortMarked).toContain("user 0")
    expect(shortMarked).toContain("user 9")
    expect(shortMarked).toHaveLength(11)
  })

  test("marks GPT-5.6 Chat user and assistant text inside the raw tail window", () => {
    const request = LLM.request({
      model: openai56Model,
      messages: [
        Message.tool({ id: "call_1", name: "lookup", result: "tool result" }),
        Message.user("latest user"),
        Message.assistant("tail assistant"),
      ],
      cache: { messages: { tail: 2 } },
      providerOptions: { openai: { promptCacheOptions: { mode: "explicit", ttl: "30m" } } },
    })

    const applied = applyCachePolicy(request)
    expect(applied.messages[1]?.content[0]).toMatchObject({ cache: { type: "ephemeral" } })
    expect(applied.messages[2]?.content[0]).toMatchObject({ cache: { type: "ephemeral" } })
    expect((applied.messages[0]?.content[0] as { cache?: unknown } | undefined)?.cache).toBeUndefined()
  })

  it.effect("'auto' is a no-op on OpenAI (implicit caching protocol)", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model: openaiModel,
          system: "Sys",
          prompt: "hi",
          cache: "auto",
        }),
      )

      const body = prepared.body as { messages: Array<{ content: unknown }> }
      // OpenAI doesn't accept cache_control on messages — policy must skip.
      const flat = JSON.stringify(body)
      expect(flat).not.toContain("cache_control")
      expect(flat).not.toContain("cachePoint")
    }),
  )

  it.effect("'auto' is a no-op on Gemini (out-of-band caching protocol)", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model: geminiModel,
          system: "Sys",
          prompt: "hi",
          cache: "auto",
        }),
      )

      const flat = JSON.stringify(prepared.body)
      expect(flat).not.toContain("cache_control")
      expect(flat).not.toContain("cachePoint")
    }),
  )

  it.effect("'auto' turns on OpenRouter's automatic breakpoint placement", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model: openrouterModel,
          system: "Sys",
          prompt: "hi",
          cache: "auto",
        }),
      )

      // OpenRouter's OpenAI-compatible surface cannot carry per-block markers on
      // tool messages, so the policy switches on OpenRouter's own top-level
      // placement instead of emitting inline hints.
      expect(prepared.body).toMatchObject({ cache_control: { type: "ephemeral" } })
      expect(JSON.stringify(prepared.body)).not.toContain("cachePoint")
    }),
  )

  it.effect("'auto' with a 1h TTL asks OpenRouter for the extended bucket", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model: openrouterModel,
          system: "Sys",
          prompt: "hi",
          cache: { system: true, messages: { tail: 1 }, ttlSeconds: 3600 },
        }),
      )

      expect(prepared.body).toMatchObject({ cache_control: { type: "ephemeral", ttl: "1h" } })
    }),
  )

  it.effect("'none' leaves OpenRouter caching untouched", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model: openrouterModel,
          system: "Sys",
          prompt: "hi",
          cache: "none",
        }),
      )

      expect(JSON.stringify(prepared.body)).not.toContain("cache_control")
    }),
  )
  it.effect("'auto' on Bedrock emits cachePoint markers in the right places", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model: bedrockModel,
          system: "Sys",
          tools: [
            {
              name: "t1",
              description: "t1",
              inputSchema: { type: "object", properties: {} },
            },
          ],
          messages: [Message.user("first user"), Message.assistant("reply"), Message.user("latest user")],
          cache: "auto",
        }),
      )

      expect(prepared.body).toMatchObject({
        toolConfig: {
          tools: [{ toolSpec: { name: "t1" } }, { cachePoint: { type: "default" } }],
        },
        system: [{ text: "Sys" }, { cachePoint: { type: "default" } }],
        messages: [
          { role: "user", content: [{ text: "first user" }] },
          {
            role: "assistant",
            content: [{ text: "reply" }, { cachePoint: { type: "default" } }],
          },
          {
            role: "user",
            content: [{ text: "latest user" }, { cachePoint: { type: "default" } }],
          },
        ],
      })
    }),
  )

  it.effect("'auto' falls back to the latest cacheable message before trailing media on Anthropic", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model: anthropicModel,
          messages: [
            Message.user("cacheable prefix"),
            Message.user({
              type: "media",
              mediaType: "image/png",
              data: "AAECAw==",
            }),
          ],
          cache: "auto",
        }),
      )

      const body = prepared.body as {
        messages: Array<{ content: Array<{ cache_control?: unknown }> }>
      }
      expect(body.messages[0]?.content[0]?.cache_control).toEqual({
        type: "ephemeral",
      })
      expect(body.messages[1]?.content[0]?.cache_control).toBeUndefined()
    }),
  )

  it.effect("'auto' falls back to the latest cacheable message before trailing media on Bedrock", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model: bedrockModel,
          messages: [
            Message.user("cacheable prefix"),
            Message.user({
              type: "media",
              mediaType: "image/png",
              data: "AAECAw==",
            }),
          ],
          cache: "auto",
        }),
      )

      const body = prepared.body as {
        messages: Array<{ content: Array<{ cachePoint?: unknown }> }>
      }
      expect(body.messages[0]?.content[1]?.cachePoint).toEqual({
        type: "default",
      })
      expect(body.messages[1]?.content[0]?.cachePoint).toBeUndefined()
    }),
  )

  it.effect("explicit tail policy selects the last cacheable message before trailing media", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model: anthropicModel,
          messages: [
            Message.user("cacheable prefix"),
            Message.user({
              type: "media",
              mediaType: "image/png",
              data: "AAECAw==",
            }),
          ],
          cache: { messages: { tail: 1 } },
        }),
      )

      const body = prepared.body as {
        messages: Array<{ content: Array<{ cache_control?: unknown }> }>
      }
      expect(body.messages[0]?.content[0]?.cache_control).toEqual({ type: "ephemeral" })
      expect(body.messages[1]?.content[0]?.cache_control).toBeUndefined()
    }),
  )

  it.effect("'auto' advances both rolling message breakpoints on direct Anthropic", () =>
    Effect.gen(function* () {
      const messages = [
        Message.user("U"),
        Message.assistant([ToolCallPart.make({ id: "call_1", name: "lookup", input: {} })]),
        Message.tool({ id: "call_1", name: "lookup", result: "T1" }),
        Message.assistant([ToolCallPart.make({ id: "call_2", name: "lookup", input: {} })]),
        Message.tool({ id: "call_2", name: "lookup", result: "T2" }),
      ]
      const attempts = yield* Effect.all(
        [1, 3, 5].map((count) =>
          LLMClient.prepare(
            LLM.request({
              model: anthropicModel,
              messages: messages.slice(0, count),
            }),
          ),
        ),
      )
      const bodies = attempts.map(
        (attempt) =>
          attempt.body as {
            messages: Array<{ content: Array<{ cache_control?: unknown }> }>
          },
      )

      // The pair advances through completed tool results, so each next attempt
      // reuses the longest completed prefix and still keeps the older anchor
      // within the 20-block lookback.
      expect(bodies[0]?.messages[0]?.content[0]?.cache_control).toEqual({
        type: "ephemeral",
      })
      expect(bodies[1]?.messages[0]?.content[0]?.cache_control).toEqual({
        type: "ephemeral",
      })
      expect(bodies[1]?.messages[2]?.content[0]?.cache_control).toEqual({
        type: "ephemeral",
      })
      expect(bodies[2]?.messages[0]?.content[0]?.cache_control).toBeUndefined()
      expect(bodies[2]?.messages[2]?.content[0]?.cache_control).toEqual({
        type: "ephemeral",
      })
      expect(bodies[2]?.messages[4]?.content[0]?.cache_control).toEqual({
        type: "ephemeral",
      })
    }),
  )

  it.effect("'auto' advances the Bedrock cache breakpoint through completed tool results", () =>
    Effect.gen(function* () {
      const messages = [
        Message.user("U"),
        Message.assistant([ToolCallPart.make({ id: "call_1", name: "lookup", input: {} })]),
        Message.tool({ id: "call_1", name: "lookup", result: "T1" }),
        Message.assistant([ToolCallPart.make({ id: "call_2", name: "lookup", input: {} })]),
        Message.tool({ id: "call_2", name: "lookup", result: "T2" }),
      ]
      const attempts = yield* Effect.all(
        [1, 3, 5].map((count) =>
          LLMClient.prepare(
            LLM.request({
              model: bedrockModel,
              messages: messages.slice(0, count),
            }),
          ),
        ),
      )
      const bodies = attempts.map(
        (attempt) =>
          attempt.body as {
            messages: Array<{ content: Array<{ cachePoint?: unknown }> }>
          },
      )

      expect(bodies[0]?.messages[0]?.content[1]?.cachePoint).toEqual({
        type: "default",
      })
      expect(bodies[1]?.messages[0]?.content[1]?.cachePoint).toEqual({
        type: "default",
      })
      expect(bodies[1]?.messages[2]?.content[1]?.cachePoint).toEqual({
        type: "default",
      })
      expect(bodies[2]?.messages[0]?.content[1]?.cachePoint).toBeUndefined()
      expect(bodies[2]?.messages[2]?.content[1]?.cachePoint).toEqual({
        type: "default",
      })
      expect(bodies[2]?.messages[4]?.content[1]?.cachePoint).toEqual({
        type: "default",
      })
    }),
  )

  it.effect("'auto' keeps a second anchor for Bedrock's bounded lookback", () =>
    Effect.gen(function* () {
      const ids = Array.from({ length: 12 }, (_, index) => `call_${index}`)
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model: bedrockModel,
          messages: [
            Message.user("stable prefix"),
            Message.assistant([
              Message.text("working"),
              ...ids.map((id) => ToolCallPart.make({ id, name: "lookup", input: {} })),
            ]),
            new Message({
              role: "tool",
              content: ids.map((id) => ToolResultPart.make({ id, name: "lookup", result: "ok" })),
            }),
          ],
        }),
      )

      const body = prepared.body as {
        messages: Array<{ content: Array<{ cachePoint?: unknown }> }>
      }
      expect(body.messages[0]?.content[0]?.cachePoint).toBeUndefined()
      expect(body.messages[1]?.content[1]?.cachePoint).toEqual({
        type: "default",
      })
      expect(body.messages[2]?.content.at(-1)?.cachePoint).toEqual({
        type: "default",
      })
    }),
  )

  it.effect("'none' disables auto placement even when manual hints exist", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model: anthropicModel,
          system: "Sys",
          tools: [
            {
              name: "t1",
              description: "t1",
              inputSchema: { type: "object", properties: {} },
            },
          ],
          prompt: "hi",
          cache: "none",
        }),
      )

      expect(prepared.body).toMatchObject({
        tools: [{ name: "t1", cache_control: undefined }],
        system: [{ type: "text", text: "Sys", cache_control: undefined }],
      })
    }),
  )

  it.effect("granular object form: tools-only marks just tools", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model: anthropicModel,
          system: "Sys",
          tools: [
            {
              name: "t1",
              description: "t1",
              inputSchema: { type: "object", properties: {} },
            },
          ],
          prompt: "hi",
          cache: { tools: true },
        }),
      )

      expect(prepared.body).toMatchObject({
        tools: [{ name: "t1", cache_control: { type: "ephemeral" } }],
        system: [{ type: "text", text: "Sys", cache_control: undefined }],
      })
    }),
  )

  it.effect("auto policy preserves manual CacheHints on other parts", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model: anthropicModel,
          system: [
            {
              type: "text",
              text: "first system",
              cache: new CacheHint({ type: "ephemeral", ttlSeconds: 3600 }),
            },
            { type: "text", text: "last system" },
          ],
          prompt: "hi",
          cache: "auto",
        }),
      )

      const body = prepared.body as {
        system: Array<{ text: string; cache_control?: unknown }>
      }
      expect(body.system[0]?.cache_control).toEqual({
        type: "ephemeral",
        ttl: "1h",
      })
      // The auto system hint joins the 1h bucket, which keeps the required
      // longest-TTL-first ordering intact alongside the manual hint above it.
      expect(body.system[1]?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" })
    }),
  )

  it.effect("four manual hints consume the automatic breakpoint budget", () =>
    Effect.gen(function* () {
      const manual = new CacheHint({ type: "ephemeral" })
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model: anthropicModel,
          tools: [
            {
              name: "t1",
              description: "t1",
              inputSchema: { type: "object", properties: {} },
            },
          ],
          system: [
            { type: "text", text: "system one", cache: manual },
            { type: "text", text: "system two", cache: manual },
          ],
          messages: [
            new Message({
              role: "user",
              content: [{ type: "text", text: "u1", cache: manual }],
            }),
            new Message({
              role: "assistant",
              content: [{ type: "text", text: "a1", cache: manual }],
            }),
            Message.user("u2"),
          ],
          cache: "auto",
        }),
      )

      const body = prepared.body as {
        tools: Array<{ cache_control?: unknown }>
        system: Array<{ cache_control?: unknown }>
        messages: Array<{ content: Array<{ cache_control?: unknown }> }>
      }
      expect(body.tools[0]?.cache_control).toBeUndefined()
      expect(body.system.map((part) => part.cache_control)).toEqual([{ type: "ephemeral" }, { type: "ephemeral" }])
      expect(body.messages.map((message) => message.content[0]?.cache_control)).toEqual([
        { type: "ephemeral" },
        { type: "ephemeral" },
        undefined,
      ])
    }),
  )

  it.effect("the auto prefix joins a manual one-hour hint instead of being dropped", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model: anthropicModel,
          tools: [
            {
              name: "t1",
              description: "t1",
              inputSchema: { type: "object", properties: {} },
            },
          ],
          system: [
            {
              type: "text",
              text: "one-hour prefix",
              cache: new CacheHint({ type: "ephemeral", ttlSeconds: 3600 }),
            },
            { type: "text", text: "default prefix" },
          ],
          prompt: "hi",
          cache: "auto",
        }),
      )

      const body = prepared.body as {
        tools: Array<{ cache_control?: unknown }>
        system: Array<{ cache_control?: unknown }>
        messages: Array<{ content: Array<{ cache_control?: unknown }> }>
      }
      // On a model with the extended bucket the auto prefix is itself 1h, so the
      // tools breakpoint no longer has to be sacrificed to keep the ordering.
      expect(body.tools[0]?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" })
      expect(body.system.map((part) => part.cache_control)).toEqual([
        { type: "ephemeral", ttl: "1h" },
        { type: "ephemeral", ttl: "1h" },
      ])
      expect(body.messages[0]?.content[0]?.cache_control).toEqual({
        type: "ephemeral",
      })
    }),
  )

  it.effect("a 5m auto prefix is dropped rather than preceding a manual one-hour hint", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          // No published profile, so the auto prefix stays on the 5m bucket and
          // the longest-TTL-first ordering has to be preserved by dropping it.
          model: unknownAnthropicModel,
          tools: [
            {
              name: "t1",
              description: "t1",
              inputSchema: { type: "object", properties: {} },
            },
          ],
          system: [
            {
              type: "text",
              text: "one-hour prefix",
              cache: new CacheHint({ type: "ephemeral", ttlSeconds: 3600 }),
            },
            { type: "text", text: "default prefix" },
          ],
          prompt: "hi",
          cache: "auto",
        }),
      )

      const body = prepared.body as {
        tools: Array<{ cache_control?: unknown }>
        system: Array<{ cache_control?: unknown }>
      }
      expect(body.tools[0]?.cache_control).toBeUndefined()
      expect(body.system.map((part) => part.cache_control)).toEqual([
        { type: "ephemeral", ttl: "1h" },
        { type: "ephemeral" },
      ])
    }),
  )

  it.effect("skips an empty trailing system block and marks the previous non-empty block", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model: anthropicModel,
          system: [
            { type: "text", text: "Stable system prefix" },
            { type: "text", text: "" },
          ],
          prompt: "hi",
          cache: { system: true },
        }),
      )

      const body = prepared.body as {
        system: Array<{ text: string; cache_control?: unknown }>
      }
      expect(body.system[0]?.cache_control).toEqual({ type: "ephemeral" })
      expect(body.system[1]?.cache_control).toBeUndefined()
    }),
  )

  it.effect("skips an empty trailing user text part and marks the previous non-empty part", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model: anthropicModel,
          messages: [
            new Message({
              role: "user",
              content: [
                { type: "text", text: "Stable user prefix" },
                { type: "text", text: "" },
              ],
            }),
          ],
          cache: { messages: "latest-user-message" },
        }),
      )

      const body = prepared.body as {
        messages: Array<{
          content: Array<{ text?: string; cache_control?: unknown }>
        }>
      }
      expect(body.messages[0]?.content[0]?.cache_control).toEqual({
        type: "ephemeral",
      })
      expect(body.messages[0]?.content[1]?.cache_control).toBeUndefined()
    }),
  )

  it.effect("does not add a cache marker when a message contains only empty text", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model: anthropicModel,
          messages: [Message.user("")],
          cache: { messages: "latest-user-message" },
        }),
      )

      expect(JSON.stringify(prepared.body)).not.toContain("cache_control")
    }),
  )

  it.effect("ttlSeconds in the policy flows through to wire markers", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model: anthropicModel,
          system: "Sys",
          prompt: "hi",
          cache: { system: true, ttlSeconds: 3600 },
        }),
      )

      expect(prepared.body).toMatchObject({
        system: [
          {
            type: "text",
            text: "Sys",
            cache_control: { type: "ephemeral", ttl: "1h" },
          },
        ],
      })
    }),
  )

  it.effect("messages: { tail: 2 } marks the last 2 message boundaries", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model: anthropicModel,
          messages: [Message.user("u1"), Message.assistant("a1"), Message.user("u2"), Message.assistant("a2")],
          cache: { messages: { tail: 2 } },
        }),
      )

      const body = prepared.body as {
        messages: Array<{ content: Array<{ cache_control?: unknown }> }>
      }
      expect(body.messages[0]?.content[0]?.cache_control).toBeUndefined()
      expect(body.messages[1]?.content[0]?.cache_control).toBeUndefined()
      expect(body.messages[2]?.content[0]?.cache_control).toEqual({
        type: "ephemeral",
      })
      expect(body.messages[3]?.content[0]?.cache_control).toEqual({
        type: "ephemeral",
      })
    }),
  )

  it.effect("'latest-assistant' marks the last assistant message", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model: anthropicModel,
          messages: [Message.user("u1"), Message.assistant("a1"), Message.user("u2")],
          cache: { messages: "latest-assistant" },
        }),
      )

      const body = prepared.body as {
        messages: Array<{ content: Array<{ cache_control?: unknown }> }>
      }
      expect(body.messages[0]?.content[0]?.cache_control).toBeUndefined()
      expect(body.messages[1]?.content[0]?.cache_control).toEqual({
        type: "ephemeral",
      })
      expect(body.messages[2]?.content[0]?.cache_control).toBeUndefined()
    }),
  )

  test("returns the same request reference when policy is a no-op (pure function)", () => {
    const request = LLM.request({
      model: anthropicModel,
      prompt: "hi",
      cache: "none",
    })
    expect(applyCachePolicy(request)).toBe(request)
  })
})

describe("volatile messages", () => {
  const volatileUser = (text: string) =>
    new Message({ role: "user", content: [{ type: "text", text }], volatile: true })

  const placement = (messages: ReadonlyArray<Message>) =>
    messages.map((message) => message.content.map((part) => ("cache" in part ? part.cache : undefined)))

  test("'auto' never marks a trailing volatile message and anchors the last two non-volatile ones", () => {
    const applied = applyCachePolicy(
      LLM.request({
        model: anthropicModel,
        messages: [
          Message.user("u1"),
          Message.assistant("a1"),
          Message.user("u2"),
          volatileUser("TeamView: child running"),
        ],
        cache: "auto",
      }),
    )

    expect(placement(applied.messages)).toEqual([
      [undefined],
      [new CacheHint({ type: "ephemeral" })],
      [new CacheHint({ type: "ephemeral" })],
      [undefined],
    ])
  })

  test("changing only the volatile message leaves hint placement byte-identical", () => {
    const build = (volatileText: string) =>
      applyCachePolicy(
        LLM.request({
          model: anthropicModel,
          system: "Sys A",
          tools: [{ name: "t1", description: "t1", inputSchema: { type: "object", properties: {} } }],
          messages: [Message.user("u1"), Message.assistant("a1"), Message.user("u2"), volatileUser(volatileText)],
        }),
      )

    const first = build("TeamView: child running")
    const second = build("TeamView: child completed with a much longer status line")
    expect(JSON.stringify(placement(second.messages.slice(0, 3)))).toBe(
      JSON.stringify(placement(first.messages.slice(0, 3))),
    )
    expect(JSON.stringify(second.system)).toBe(JSON.stringify(first.system))
    expect(JSON.stringify(second.tools)).toBe(JSON.stringify(first.tools))
    expect(placement(second.messages).at(-1)).toEqual([undefined])
  })

  test("explicit tail policy anchors the last cacheable message before a volatile tail", () => {
    const applied = applyCachePolicy(
      LLM.request({
        model: anthropicModel,
        messages: [Message.user("u1"), volatileUser("TeamView")],
        cache: { messages: { tail: 1 } },
      }),
    )

    expect(placement(applied.messages)).toEqual([[new CacheHint({ type: "ephemeral" })], [undefined]])
  })

  test("explicit tail policy preserves two rolling anchors before two volatile messages", () => {
    const applied = applyCachePolicy(
      LLM.request({
        model: anthropicModel,
        messages: [
          Message.user("u1"),
          Message.assistant("a1"),
          Message.user("u2"),
          volatileUser("TeamView: child running"),
          volatileUser("TeamView: approval pending"),
        ],
        cache: { messages: { tail: 2 } },
      }),
    )

    expect(placement(applied.messages)).toEqual([
      [undefined],
      [new CacheHint({ type: "ephemeral" })],
      [new CacheHint({ type: "ephemeral" })],
      [undefined],
      [undefined],
    ])
  })

  test("'latest-user-message' falls back to the newest non-volatile user message", () => {
    const applied = applyCachePolicy(
      LLM.request({
        model: anthropicModel,
        messages: [Message.user("u1"), volatileUser("TeamView")],
        cache: { messages: "latest-user-message" },
      }),
    )

    expect(placement(applied.messages)).toEqual([[new CacheHint({ type: "ephemeral" })], [undefined]])
  })

  test("placement is unchanged when no message is volatile", () => {
    const applied = applyCachePolicy(
      LLM.request({
        model: anthropicModel,
        messages: [Message.user("u1"), Message.assistant("a1"), Message.user("u2")],
        cache: "auto",
      }),
    )

    expect(placement(applied.messages)).toEqual([
      [undefined],
      [new CacheHint({ type: "ephemeral" })],
      [new CacheHint({ type: "ephemeral" })],
    ])
  })
})
