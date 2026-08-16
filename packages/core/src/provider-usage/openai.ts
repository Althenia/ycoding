export * as OpenAIUsage from "./openai"

import { ProviderUsage } from "@ycoding-ai/schema/provider-usage"
import { ProviderV2 } from "../provider"

interface Bucket {
  readonly start_time?: unknown
  readonly end_time?: unknown
  readonly results?: unknown
}

export interface NormalizeInput {
  readonly providerID: ProviderV2.ID
  readonly label: string
  readonly updatedAt: number
  readonly weekStart: number
  readonly monthStart: number
  readonly usage: ReadonlyArray<Bucket>
  readonly costs: ReadonlyArray<Bucket>
}

export function normalize(input: NormalizeInput) {
  const usage = input.usage.map(usageBucket)
  const costs = input.costs.map(costBucket)
  const weekUsage = usage.filter((bucket) => bucket.start >= input.weekStart)
  const monthUsage = usage.filter((bucket) => bucket.start >= input.monthStart)
  const weekCosts = costs.filter((bucket) => bucket.start >= input.weekStart)
  const monthCosts = costs.filter((bucket) => bucket.start >= input.monthStart)

  return new ProviderUsage.Snapshot({
    providerID: input.providerID,
    label: input.label,
    status: "available",
    source: "provider_api",
    stability: "stable",
    updatedAt: Math.max(0, Math.trunc(input.updatedAt)),
    windows: [
      window("week-cost", "This week", "usd", sum(weekCosts, (bucket) => bucket.cost)),
      window("month-cost", "This month", "usd", sum(monthCosts, (bucket) => bucket.cost)),
      window("week-requests", "Weekly requests", "requests", sum(weekUsage, (bucket) => bucket.requests)),
      window("month-requests", "Monthly requests", "requests", sum(monthUsage, (bucket) => bucket.requests)),
      window("week-tokens", "Weekly tokens", "tokens", sum(weekUsage, (bucket) => bucket.tokens)),
      window("month-tokens", "Monthly tokens", "tokens", sum(monthUsage, (bucket) => bucket.tokens)),
    ],
  })
}

export function isAdminCredential(metadata: Readonly<Record<string, unknown>> | undefined) {
  return metadata?.usageAdmin === true || metadata?.usage_admin === true
}

function usageBucket(value: Bucket) {
  const start = timestamp(value.start_time, "start_time")
  timestamp(value.end_time, "end_time")
  if (!Array.isArray(value.results)) throw new Error("Invalid OpenAI usage results")
  const result = value.results.reduce(
    (total, item) => {
      if (!record(item)) throw new Error("Invalid OpenAI usage result")
      return {
        requests: total.requests + number(item.num_model_requests, "num_model_requests"),
        tokens:
          total.tokens +
          number(item.input_tokens, "input_tokens") +
          number(item.output_tokens, "output_tokens"),
      }
    },
    { requests: 0, tokens: 0 },
  )
  return { start, ...result }
}

function costBucket(value: Bucket) {
  const start = timestamp(value.start_time, "start_time")
  timestamp(value.end_time, "end_time")
  if (!Array.isArray(value.results)) throw new Error("Invalid OpenAI cost results")
  const cost = value.results.reduce((total, item) => {
    if (!record(item) || !record(item.amount)) throw new Error("Invalid OpenAI cost result")
    if (item.amount.currency !== "usd") throw new Error("Unsupported OpenAI cost currency")
    return total + number(item.amount.value, "amount.value")
  }, 0)
  return { start, cost }
}

function window(id: string, label: string, unit: ProviderUsage.Unit, used: number) {
  return new ProviderUsage.Window({ id, label, unit, used })
}

function sum<T>(values: ReadonlyArray<T>, select: (value: T) => number) {
  return values.reduce((total, value) => total + select(value), 0)
}

function timestamp(value: unknown, field: string) {
  return Math.trunc(number(value, field))
}

function number(value: unknown, field: string) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw new Error(`Invalid OpenAI usage response: ${field}`)
  return value
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
