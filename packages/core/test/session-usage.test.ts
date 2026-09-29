import { Usage } from "@ycoding-ai/ai"
import { ModelV2 } from "@ycoding-ai/core/model"
import { SessionUsage } from "@ycoding-ai/core/session/usage"
import { Money } from "@ycoding-ai/schema/money"
import { expect, test } from "bun:test"

const costs = (input: number, output: number) =>
  [
    {
      input: Money.USDPerMillionTokens.make(input),
      output: Money.USDPerMillionTokens.make(output),
      cache: {
        read: Money.USDPerMillionTokens.zero,
        write: Money.USDPerMillionTokens.zero,
      },
    },
  ] satisfies ModelV2.Info["cost"]

test("preserves whether provider cache categories were reported", () => {
  expect(SessionUsage.providerCache(undefined)).toEqual({ readReported: false, writeReported: false })
  expect(
    SessionUsage.providerCache(
      new Usage({
        cacheReadInputTokens: 0,
        cacheWriteInputTokens: undefined,
      }),
    ),
  ).toEqual({ readReported: true, writeReported: false })
  expect(
    SessionUsage.providerCache(
      new Usage({
        cacheReadInputTokens: undefined,
        cacheWriteInputTokens: 0,
      }),
    ),
  ).toEqual({ readReported: false, writeReported: true })
})

test("keeps provider timings separate from token accounting", () => {
  const usage = new Usage({ inputTokens: 20, nonCachedInputTokens: 12, cacheReadInputTokens: 8,
    promptEvalDurationNs: 4_000_000, generationDurationNs: 5_000_000, loadDurationNs: 6_000_000 })
  expect(SessionUsage.timing(usage)).toEqual({
    promptEvalDurationNs: 4_000_000, generationDurationNs: 5_000_000, loadDurationNs: 6_000_000,
  })
  expect(SessionUsage.timing(new Usage({ inputTokens: 5 }))).toBeUndefined()
  expect(SessionUsage.tokens(usage).cache.read).toBe(8)
  expect(SessionUsage.timing(new Usage({ promptEvalDurationNs: -1, loadDurationNs: Number.NaN }))).toBeUndefined()
})

test("counts only observed output categories and keeps provider timing independent", () => {
  const times = { text: 2_000_000_000n, reasoning: 1_000_000_000n, ended: 3_000_000_000n }
  expect(SessionUsage.generationTiming(new Usage({ outputTokens: 12, outputMayIncludeUnreportedReasoning: true }), {
    ...times, reasoning: undefined,
  })).toBeUndefined()
  expect(SessionUsage.generationTiming(new Usage({ outputTokens: 12, outputMayIncludeUnreportedReasoning: true }), times))
    .toEqual({ generatedTokens: 12, observedGenerationDurationNs: 2_000_000_000 })
  expect(SessionUsage.generationTiming(new Usage({ outputTokens: 12, reasoningTokens: 4 }), {
    ...times, reasoning: undefined,
  })).toEqual({ generatedTokens: 8, observedGenerationDurationNs: 1_000_000_000 })
  expect(SessionUsage.generationTiming(new Usage({ outputTokens: 12, reasoningTokens: 4 }), times))
    .toEqual({ generatedTokens: 12, observedGenerationDurationNs: 2_000_000_000 })
  expect(SessionUsage.generationTiming(new Usage({ outputTokens: 2_355 }), {
    text: 30_000_000_000n, ended: 30_071_223_792n,
  })).toEqual({ generatedTokens: 2_355 })
  expect(SessionUsage.generationTiming(new Usage({ outputTokens: 12 }), { ...times, text: undefined, reasoning: undefined }))
    .toBeUndefined()
  expect(SessionUsage.generationTiming(new Usage({ outputTokens: 12 }), { ...times, ended: 2_000_000n }))
    .toEqual({ generatedTokens: 12 })
  expect(SessionUsage.generationTiming(new Usage({ outputTokens: 12 }), { ...times, ended: BigInt(Number.MAX_SAFE_INTEGER) + times.text + 3n }))
    .toEqual({ generatedTokens: 12 })
})

test("falls back to the OpenRouter master price only when provider pricing is unavailable", () => {
  const usage = { input: 1_000, output: 100, reasoning: 50, cache: { read: 0, write: 0 } }

  expect(SessionUsage.estimatedCatalogCost(costs(2, 8), costs(20, 80), usage)).toEqual({
    cost: Money.USD.make(0.0032),
    source: "provider",
  })
  expect(SessionUsage.estimatedCatalogCost([], costs(20, 80), usage)).toEqual({
    cost: Money.USD.make(0.032),
    source: "openrouter",
  })
  expect(SessionUsage.estimatedCatalogCost([], [], usage)).toBeUndefined()
})

test("prices Anthropic one-hour cache writes at twice input while preserving aggregate token totals", () => {
  const opus = [{
    input: Money.USDPerMillionTokens.make(4),
    output: Money.USDPerMillionTokens.make(0),
    cache: { read: Money.USDPerMillionTokens.zero, write: Money.USDPerMillionTokens.make(5) },
  }] satisfies ModelV2.Info["cost"]
  const usage = (oneHour: unknown) => new Usage({
    inputTokens: 2_000,
    nonCachedInputTokens: 0,
    cacheWriteInputTokens: 2_000,
    providerMetadata: { anthropic: { cache_creation: {
      ephemeral_5m_input_tokens: 1_000,
      ephemeral_1h_input_tokens: oneHour,
    } } },
  })

  expect(SessionUsage.record(usage(1_000), opus).cost).toEqual(Money.USD.make(0.013))
  expect(SessionUsage.record(new Usage({ cacheWriteInputTokens: 1_000, providerMetadata: {
    anthropic: { cache_creation: { ephemeral_1h_input_tokens: 1_000 } },
  } }), opus).cost).toEqual(Money.USD.make(0.008))
  expect(SessionUsage.record(new Usage({ cacheWriteInputTokens: 1_000 }), opus).cost).toEqual(Money.USD.make(0.005))
  expect(SessionUsage.record(usage(undefined), opus).cost).toEqual(Money.USD.make(0.01))
  expect(SessionUsage.record(usage(2_001), opus).cost).toEqual(Money.USD.make(0.01))
  expect(SessionUsage.record(usage(1_000), opus).tokens.cache.write).toBe(2_000)
})
