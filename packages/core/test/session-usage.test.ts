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
