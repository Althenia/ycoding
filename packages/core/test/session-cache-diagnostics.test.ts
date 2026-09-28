import { expect, test } from "bun:test"
import { DateTime } from "effect"
import { AgentV2 } from "@ycoding-ai/core/agent"
import { Money } from "@ycoding-ai/schema/money"
import { SessionCacheDiagnostics } from "@ycoding-ai/core/session/cache-diagnostics"
import { SessionContextPressure } from "@ycoding-ai/core/session/context-pressure"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { ModelV2 } from "@ycoding-ai/core/model"
import { ProviderV2 } from "@ycoding-ai/core/provider"

const model = (providerID: string) =>
  ModelV2.Ref.make({ id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make(providerID) })

const namedModel = (providerID: string, id: string) =>
  ModelV2.Ref.make({ id: ModelV2.ID.make(id), providerID: ProviderV2.ID.make(providerID) })

const tokens = {
  input: 100,
  output: 20,
  reasoning: 10,
  cache: { read: 900, write: 0 },
}

test("estimates prepared request parts by model-visible category without altering pressure estimation", () => {
  const request = {
    system: [{ type: "text" as const, text: "System instructions for the model" }],
    tools: [{ name: "read", description: "Read a file", inputSchema: { type: "object" } }],
    messages: [
      { role: "system" as const, content: [{ type: "text" as const, text: "Chronological system update" }] },
      { role: "user" as const, content: [{ type: "text" as const, text: "User question" }, { type: "media" as const, mediaType: "image/png", data: "image" }] },
      { role: "assistant" as const, content: [{ type: "text" as const, text: "Assistant answer" }, { type: "reasoning" as const, text: "Thought content" }, { type: "tool-call" as const, id: "call", name: "read", input: { path: "file" } }] },
      { role: "tool" as const, content: [{ type: "tool-result" as const, id: "call", name: "read", result: { type: "text" as const, value: "contents" } }] },
    ],
  }
  const before = SessionContextPressure.estimatedInputTokens(request)
  const result = SessionContextPressure.breakdown(request)
  for (const category of ["system", "tools", "user", "assistant", "reasoning", "toolCalls", "other"] as const)
    expect(result[category]).toBeGreaterThan(0)
  expect(SessionContextPressure.estimatedInputTokens(request)).toBe(before)
  expect(SessionContextPressure.breakdown({ system: [], tools: [], messages: [] })).toEqual({
    system: 0, tools: 0, user: 0, assistant: 0, reasoning: 0, toolCalls: 0, other: 0,
  })
})

test("keeps cache effectiveness separate from context occupancy", () => {
  const result = SessionCacheDiagnostics.calculate({
    tokens,
    estimatedCost: Money.USD.make(0.0123),
    contextLimit: 2_000,
    model: model("openai"),
    routeID: "openai-responses",
    providerCache: {
      mechanism: "openai-prefix-cache",
      readReported: true,
      writeReported: true,
    },
  })

  expect(result.context).toEqual({ total: 1_030, limit: 2_000, remaining: 970, percent: 52 })
  expect(result.tokens).toEqual({
    uncachedInput: 100,
    output: 20,
    reasoning: 10,
    cacheRead: 900,
    cacheWrite: 0,
  })
  expect(result.cache).toEqual({
    eligible: 1_000,
    hitRatio: 0.9,
    mechanism: "openai-prefix-cache",
    readReported: true,
    writeReported: true,
  })
  expect(result.estimatedCost).toBe(Money.USD.make(0.0123))
})

test("derives speed from the latest Step and at most eight recent requests", () => {
  const records = Array.from({ length: 10 }, (_, index) => ({
    model: model("openai"),
    timing: index === 9 ? { generatedTokens: 10, generationDurationNs: 0, observedGenerationDurationNs: 2_000_000 }
      : { generatedTokens: 10 + index, generationDurationNs: 2_000_000, observedGenerationDurationNs: 8_000_000 },
  }))
  const withZero = SessionCacheDiagnostics.generationSpeed(records)
  expect(withZero?.latest).toBeUndefined()
  expect(withZero?.recent.map((sample) => sample.tokens)).toEqual([12, 13, 14, 15, 16, 17, 18])
  expect(withZero?.recent.at(-1)?.tokensPerSecond).toBe(9_000)
  const current = { model: model("anthropic"),
    timing: { generatedTokens: 12, generationDurationNs: 2_000_000 } }
  expect(SessionCacheDiagnostics.generationSpeed(records, current)?.latest).toMatchObject({
    model: current.model, tokensPerSecond: 6_000,
  })
  expect(SessionCacheDiagnostics.generationSpeed([], current)?.recent).toHaveLength(1)
  expect(SessionCacheDiagnostics.generationSpeed([])).toBeUndefined()
})

test("reconstructs the last request breakdown from projected assistant diagnostics", () => {
  const contextBreakdown = { system: 2, tools: 0, user: 4, assistant: 0, reasoning: 0, toolCalls: 0, other: 0 }
  const messages = [SessionMessage.Assistant.make({
    id: SessionMessage.ID.create(), type: "assistant", agent: AgentV2.defaultID, model: model("openai"), content: [],
    tokens, cost: Money.USD.zero, diagnostics: { contextBreakdown }, time: { created: DateTime.makeUnsafe(0) },
  })]
  expect(SessionCacheDiagnostics.fromMessages(messages)?.contextBreakdown).toEqual(contextBreakdown)
  expect(SessionCacheDiagnostics.fromMessages(messages)?.context.total).toBe(1030)
})

test("reports zero cache hits without lowering the context total", () => {
  const result = SessionCacheDiagnostics.calculate({
    tokens: { ...tokens, input: 1_000, cache: { read: 0, write: 0 } },
    estimatedCost: Money.USD.zero,
    contextLimit: 2_000,
    model: model("anthropic"),
    routeID: "anthropic-messages",
    providerCache: {
      mechanism: "anthropic-cache-control",
      readReported: true,
      writeReported: true,
    },
  })

  expect(result.context.total).toBe(1_030)
  expect(result.cache).toEqual({
    eligible: 1_000,
    hitRatio: 0,
    mechanism: "anthropic-cache-control",
    readReported: true,
    writeReported: true,
  })
})

test("omits ratios and limits when no denominator or valid context limit exists", () => {
  const result = SessionCacheDiagnostics.calculate({
    tokens: { input: 0, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
    estimatedCost: Money.USD.zero,
    contextLimit: 0,
    model: model("custom"),
  })

  expect(result.context).toEqual({ total: 5 })
  expect(result.cache).toEqual({
    eligible: 0,
    mechanism: "none",
    readReported: false,
    writeReported: false,
  })
})

test("labels unknown providers only when they report cache activity", () => {
  expect(
    SessionCacheDiagnostics.calculate({
      tokens: { input: 10, output: 0, reasoning: 0, cache: { read: 5, write: 0 } },
      estimatedCost: Money.USD.zero,
      model: model("custom"),
    }).cache,
  ).toEqual({
    eligible: 15,
    hitRatio: 1 / 3,
    mechanism: "provider-reported",
    readReported: true,
    writeReported: false,
  })
})

test("derives provider cache mechanisms from the executed route", () => {
  expect(SessionCacheDiagnostics.mechanism("ai-sdk:@ai-sdk/anthropic", model("anthropic"), tokens)).toBe(
    "anthropic-cache-control",
  )
  expect(SessionCacheDiagnostics.mechanism("ai-sdk:@openrouter/ai-sdk-provider", model("openrouter"), tokens)).toBe(
    "openrouter-cache-control",
  )
  expect(SessionCacheDiagnostics.mechanism("ai-sdk:@ai-sdk/amazon-bedrock", model("amazon-bedrock"), tokens)).toBe(
    "bedrock-cache-point",
  )
  expect(SessionCacheDiagnostics.mechanism("ai-sdk:@ai-sdk/github-copilot", model("github-copilot"), tokens)).toBe(
    "openai-prefix-cache",
  )
  expect(SessionCacheDiagnostics.mechanism("gemini", model("google"), tokens)).toBe("gemini-prefix-cache")
})

test("derives provider cache mechanisms from native (non-AI-SDK) route ids", () => {
  expect(SessionCacheDiagnostics.mechanism("runpod-ollama", model("runpod"), {
    input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 },
  })).toBe("provider-reported")
  const cases = {
    openrouter: "openrouter-cache-control",
    "google-vertex-messages": "anthropic-cache-control",
    "google-vertex-gemini": "gemini-prefix-cache",
    "google-vertex-chat": "openai-prefix-cache",
    "google-vertex-responses": "openai-prefix-cache",
    "azure-openai-chat": "openai-prefix-cache",
    "azure-openai-responses": "openai-prefix-cache",
    "openai-compatible-chat": "openai-prefix-cache",
    "openai-compatible-responses": "openai-prefix-cache",
    "openai-responses-websocket": "openai-prefix-cache",
    "openai-codex-responses": "openai-prefix-cache",
    "openai-codex-websocket-responses": "openai-prefix-cache",
    "github-copilot-chat": "openai-prefix-cache",
    "github-copilot-responses": "openai-prefix-cache",
    "runpod-ollama": "provider-reported",
    "runpod-vllm": "provider-reported",
  } as const
  for (const [routeID, expected] of Object.entries(cases))
    expect([routeID, SessionCacheDiagnostics.mechanism(routeID, model("anthropic"), tokens)]).toEqual([
      routeID,
      expected,
    ])
})

test("reports the model's minimum cacheable prefix and flags a prefix below it", () => {
  // 900 eligible tokens is under Opus 4.6's 4096-token minimum, so the provider
  // ignores the breakpoints and the 0% ratio is expected rather than a fault.
  const below = SessionCacheDiagnostics.calculate({
    tokens: { input: 900, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
    estimatedCost: Money.USD.zero,
    model: namedModel("anthropic", "claude-opus-4-6"),
    routeID: "anthropic-messages",
  })
  expect(below.cache.minimumTokens).toBe(4096)
  expect(below.cache.belowMinimum).toBe(true)

  const above = SessionCacheDiagnostics.calculate({
    tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 9_000, write: 0 } },
    estimatedCost: Money.USD.zero,
    model: namedModel("anthropic", "claude-opus-4-6"),
    routeID: "anthropic-messages",
  })
  expect(above.cache.minimumTokens).toBe(4096)
  expect(above.cache.belowMinimum).toBe(false)
})

test("resolves the minimum through platform-qualified model ids", () => {
  const bedrock = SessionCacheDiagnostics.calculate({
    tokens,
    estimatedCost: Money.USD.zero,
    model: namedModel("amazon-bedrock", "us.anthropic.claude-opus-4-8"),
    routeID: "bedrock-converse",
  })
  expect(bedrock.cache.minimumTokens).toBe(1024)
})

test("omits the minimum when the model has no published cache profile", () => {
  const result = SessionCacheDiagnostics.calculate({
    tokens,
    estimatedCost: Money.USD.zero,
    model: namedModel("custom", "some-self-hosted-llama"),
    routeID: "openai-compatible-chat",
  })
  expect(result.cache.minimumTokens).toBeUndefined()
  expect(result.cache.belowMinimum).toBeUndefined()
})

test("uses the latest provider telemetry after switching from Claude to GPT", () => {
  const created = DateTime.makeUnsafe(0)
  const assistant = (
    id: string,
    selected: ModelV2.Ref,
    cache: { read: number; write: number },
    mechanism: "anthropic-cache-control" | "openai-prefix-cache",
  ) =>
    SessionMessage.Assistant.make({
      id: SessionMessage.ID.make(id),
      type: "assistant",
      agent: AgentV2.defaultID,
      model: selected,
      content: [],
      tokens: { input: 100, output: 20, reasoning: 0, cache },
      diagnostics: { providerCache: { mechanism, readReported: true, writeReported: true } },
      time: { created, completed: created },
    })
  const claude = namedModel("anthropic", "claude-opus-4-8")
  const gpt = namedModel("openai", "gpt-5.6")

  const result = SessionCacheDiagnostics.fromMessages([
    assistant("msg_claude", claude, { read: 900, write: 0 }, "anthropic-cache-control"),
    assistant("msg_gpt", gpt, { read: 0, write: 25 }, "openai-prefix-cache"),
  ])

  expect(result?.model).toEqual(gpt)
  expect(result?.tokens).toMatchObject({ cacheRead: 0, cacheWrite: 25 })
  expect(result?.cache).toMatchObject({ mechanism: "openai-prefix-cache", hitRatio: 0 })
})
