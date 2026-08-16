import { expect, test } from "bun:test"
import { Money } from "@ycoding-ai/schema/money"
import { SessionCacheDiagnostics } from "@ycoding-ai/core/session/cache-diagnostics"
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
  expect(SessionCacheDiagnostics.mechanism("gemini", model("google"), tokens)).toBe("gemini-prefix-cache")
})

test("derives provider cache mechanisms from native (non-AI-SDK) route ids", () => {
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
