export * as SessionUsage from "./usage"

import type { Usage } from "@ycoding-ai/ai"
import type { ProviderRequest } from "@ycoding-ai/schema/provider-request"
import { Money } from "@ycoding-ai/schema/money"
import type { TokenUsage } from "@ycoding-ai/schema/token-usage"
import type { ModelV2 } from "../model"

const safe = (value: number | undefined) => Math.max(0, Number.isFinite(value) ? (value ?? 0) : 0)

export const tokens = (usage: Usage | undefined): TokenUsage.Info => ({
  input: safe(usage?.nonCachedInputTokens),
  output: safe(usage?.visibleOutputTokens),
  reasoning: safe(usage?.reasoningTokens),
  cache: {
    read: safe(usage?.cacheReadInputTokens),
    write: safe(usage?.cacheWriteInputTokens),
  },
})

export const providerCache = (usage: Usage | undefined) => ({
  readReported: usage?.cacheReadInputTokens !== undefined,
  writeReported: usage?.cacheWriteInputTokens !== undefined,
})

export const oneHourCacheWrites = (usage: Usage | undefined) => {
  if (!usage) return undefined
  const metadata = usage.providerMetadata?.anthropic
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) return undefined
  const creation = (metadata as Record<string, unknown>).cache_creation
  if (typeof creation !== "object" || creation === null || Array.isArray(creation)) return undefined
  const count = (creation as Record<string, unknown>).ephemeral_1h_input_tokens
  if (
    typeof count !== "number" ||
    !Number.isFinite(count) ||
    count < 0 ||
    count > safe(usage.cacheWriteInputTokens)
  )
    return undefined
  return count
}

export const timing = (usage: Usage | undefined): ProviderRequest.Timing | undefined => {
  const duration = (value: number | undefined) =>
    value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : undefined
  const promptEvalDurationNs = duration(usage?.promptEvalDurationNs)
  const generationDurationNs = duration(usage?.generationDurationNs)
  const loadDurationNs = duration(usage?.loadDurationNs)
  const values = {
    ...(promptEvalDurationNs === undefined ? {} : { promptEvalDurationNs }),
    ...(generationDurationNs === undefined ? {} : { generationDurationNs }),
    ...(loadDurationNs === undefined ? {} : { loadDurationNs }),
  }
  return Object.keys(values).length === 0 ? undefined : values
}

// TODO(#35765): Use Copilot's reported billed amount once billing has a dedicated typed runtime contract.
export function estimatedCost(
  costs: ModelV2.Info["cost"],
  usage: TokenUsage.Info,
  oneHourWrites?: number,
): Money.USD | undefined {
  const context = usage.input + usage.cache.read + usage.cache.write
  const tier = costs
    .filter((cost) => cost.tier?.type === "context" && context > cost.tier.size)
    .toSorted((a, b) => (b.tier?.size ?? 0) - (a.tier?.size ?? 0))[0]
  const cost = tier ?? costs.find((cost) => cost.tier === undefined)
  if (!cost) return undefined
  const validOneHourWrites =
    oneHourWrites !== undefined && Number.isFinite(oneHourWrites) && oneHourWrites >= 0 && oneHourWrites <= usage.cache.write
      ? oneHourWrites
      : undefined
  return Money.USD.make(
    (usage.input * cost.input +
      (usage.output + usage.reasoning) * cost.output +
      usage.cache.read * cost.cache.read +
      (validOneHourWrites === undefined
        ? usage.cache.write * cost.cache.write
        : 2 * validOneHourWrites * cost.input +
          (usage.cache.write - validOneHourWrites) * cost.cache.write)) /
      1_000_000,
  )
}

export function estimatedCatalogCost(
  costs: ModelV2.Info["cost"],
  openRouterCosts: ModelV2.Info["cost"],
  usage: TokenUsage.Info,
) {
  const provider = estimatedCost(costs, usage)
  if (provider !== undefined) return { cost: provider, source: "provider" as const }
  const openrouter = estimatedCost(openRouterCosts, usage)
  if (openrouter !== undefined) return { cost: openrouter, source: "openrouter" as const }
}

export function calculateCost(costs: ModelV2.Info["cost"], usage: TokenUsage.Info, oneHourWrites?: number) {
  return estimatedCost(costs, usage, oneHourWrites) ?? Money.USD.zero
}

export type Recorded = { readonly tokens: TokenUsage.Info; readonly cost: Money.USD }

export const record = (usage: Usage | undefined, costs: ModelV2.Info["cost"]): Recorded => {
  const normalized = tokens(usage)
  return { tokens: normalized, cost: calculateCost(costs, normalized, oneHourCacheWrites(usage)) }
}

export const add = (a: Recorded, b: Recorded): Recorded => ({
  cost: Money.USD.make(a.cost + b.cost),
  tokens: {
    input: a.tokens.input + b.tokens.input,
    output: a.tokens.output + b.tokens.output,
    reasoning: a.tokens.reasoning + b.tokens.reasoning,
    cache: {
      read: a.tokens.cache.read + b.tokens.cache.read,
      write: a.tokens.cache.write + b.tokens.cache.write,
    },
  },
})
