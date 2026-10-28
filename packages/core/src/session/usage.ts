export * as SessionUsage from "./usage"

import type { Usage } from "@ycoding-ai/ai"
import type { ProviderRequest } from "@ycoding-ai/schema/provider-request"
import { Money } from "@ycoding-ai/schema/money"
import type { TokenUsage } from "@ycoding-ai/schema/token-usage"
import type { CatalogModel } from "../model"
import { Token } from "../util/token"

const safe = (value: number | undefined) => Math.max(0, Number.isFinite(value) ? (value ?? 0) : 0)

export function receivedOutput() {
  const points: { time: bigint; tokens: number }[] = []
  return {
    observe(time: bigint, tokens: number) {
      if (!Number.isSafeInteger(tokens) || tokens < 0) return
      const point = { time, tokens }
      while (points.length && points[0]!.time < time - 5_000_000_000n) points.shift()
      const last = points.at(-1)
      if (last?.time === time) {
        points[points.length - 1] = point
        return
      }
      if (points.length > 1 && time - points[points.length - 2]!.time < 250_000_000n) points.pop()
      points.push(point)
    },
    sample() {
      const first = points[0]
      const last = points.at(-1)
      if (!first || !last) return undefined
      const duration = last.time - first.time
      const estimatedTokens = last.tokens - first.tokens
      if (duration < 1_000_000_000n || duration > BigInt(Number.MAX_SAFE_INTEGER) ||
        !Number.isSafeInteger(estimatedTokens) || estimatedTokens <= 0) return undefined
      return { estimatedTokens, durationNs: Number(duration) }
    },
  }
}

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

export const generationTiming = (
  usage: Usage | undefined,
  times: { readonly started?: bigint; readonly text?: bigint; readonly reasoning?: bigint; readonly toolInput?: bigint; readonly ended: bigint; readonly streamedOutput?: string },
): Pick<ProviderRequest.Timing, "generatedTokens" | "observedGenerationDurationNs" | "estimatedTokens" | "estimatedGenerationDurationNs"> | undefined => {
  const normalized = tokens(usage)
  const generatedTokens = normalized.output + normalized.reasoning
  const measured = Number.isSafeInteger(generatedTokens) && generatedTokens > 0 ? { generatedTokens } : undefined
  const start = earliest([times.text, times.reasoning, times.toolInput]) ?? times.started
  if (start === undefined) return measured
  const duration = times.ended - start
  if (duration < 0n || duration > BigInt(Number.MAX_SAFE_INTEGER)) return measured
  const durationNs = Number(duration === 0n ? 1n : duration)
  if (measured) return { ...measured, observedGenerationDurationNs: durationNs }
  if (!times.streamedOutput?.length) return undefined
  return { estimatedTokens: Math.max(1, Token.estimate(times.streamedOutput)), estimatedGenerationDurationNs: durationNs }
}

function earliest(values: ReadonlyArray<bigint | undefined>) {
  return values.reduce<bigint | undefined>(
    (result, value) => value === undefined || (result !== undefined && result <= value) ? result : value,
    undefined,
  )
}

// TODO(#35765): Use Copilot's reported billed amount once billing has a dedicated typed runtime contract.
export function estimatedCost(
  costs: CatalogModel.Info["cost"],
  usage: TokenUsage.Info,
  oneHourWrites?: number,
  context = usage.input + usage.cache.read + usage.cache.write,
): Money.USD | undefined {
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
  costs: CatalogModel.Info["cost"],
  openRouterCosts: CatalogModel.Info["cost"],
  usage: TokenUsage.Info,
  context?: number,
) {
  const provider = estimatedCost(costs, usage, undefined, context)
  if (provider !== undefined) return { cost: provider, source: "provider" as const }
  const openrouter = estimatedCost(openRouterCosts, usage, undefined, context)
  if (openrouter !== undefined) return { cost: openrouter, source: "openrouter" as const }
}

export function calculateCost(costs: CatalogModel.Info["cost"], usage: TokenUsage.Info, oneHourWrites?: number) {
  return estimatedCost(costs, usage, oneHourWrites) ?? Money.USD.zero
}

export type Recorded = { readonly tokens: TokenUsage.Info; readonly cost: Money.USD }

export const record = (usage: Usage | undefined, costs: CatalogModel.Info["cost"]): Recorded => {
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
