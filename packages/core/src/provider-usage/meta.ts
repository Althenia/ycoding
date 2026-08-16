export * as MetaUsage from "./meta"

import { ProviderUsage } from "@ycoding-ai/schema/provider-usage"
import { ProviderV2 } from "../provider"

// The standalone Meta adapter consumes organization usage and cost buckets
// with start_time/end_time/results. Per-request usage from OpenAI-compatible
// routes remains separate; this snapshot reports provider-side usage and the
// current calendar-month bill for configured Meta credentials.

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
  const weekUsage = usage.filter((b) => b.start >= input.weekStart)
  const monthUsage = usage.filter((b) => b.start >= input.monthStart)
  const monthCosts = costs.filter((b) => b.start >= input.monthStart)
  const currentBill = sumOptional(monthCosts, (b) => b.cost)
  const dueAt = monthCosts.length === 0 ? undefined : nextBillDueAt(input.monthStart)
  return new ProviderUsage.Snapshot({
    providerID: input.providerID,
    label: input.label,
    status: "available",
    source: "provider_api",
    stability: "stable",
    updatedAt: Math.max(0, Math.trunc(input.updatedAt)),
    windows: [
      new ProviderUsage.Window({
        id: "current-bill",
        label: "Current bill",
        unit: "usd",
        ...(currentBill === undefined ? {} : { used: currentBill }),
        ...(dueAt === undefined ? {} : { resetAt: dueAt }),
      }),
      window("week-requests", "Weekly requests", "requests", sum(weekUsage, (b) => b.requests)),
      window("month-requests", "Monthly requests", "requests", sum(monthUsage, (b) => b.requests)),
      window("week-tokens", "Weekly tokens", "tokens", sum(weekUsage, (b) => b.tokens)),
      window("month-tokens", "Monthly tokens", "tokens", sum(monthUsage, (b) => b.tokens)),
    ],
  })
}

export function isAdminCredential(metadata: Readonly<Record<string, unknown>> | undefined) {
  return metadata?.usageAdmin === true || metadata?.usage_admin === true || metadata?.isAdmin === true
}

function usageBucket(value: Bucket) {
  const start = timestamp(value.start_time, "start_time")
  timestamp(value.end_time, "end_time")
  if (!Array.isArray(value.results)) throw new Error("Invalid Meta usage results")
  const result = value.results.reduce(
    (total, item) => {
      if (!record(item)) throw new Error("Invalid Meta usage result")
      // Meta mirrors OpenAI: num_model_requests / input_tokens / output_tokens
      return {
        requests: total.requests + number(item.num_model_requests ?? item.num_requests ?? 0, "num_model_requests"),
        tokens:
          total.tokens +
          number(item.input_tokens ?? item.prompt_tokens ?? 0, "input_tokens") +
          number(item.output_tokens ?? item.completion_tokens ?? 0, "output_tokens"),
      }
    },
    { requests: 0, tokens: 0 },
  )
  return { start, ...result }
}

function costBucket(value: Bucket) {
  const start = timestamp(value.start_time, "start_time")
  timestamp(value.end_time, "end_time")
  if (!Array.isArray(value.results)) throw new Error("Invalid Meta cost results")
  const costs = value.results.map((item) => {
    if (!record(item) || !record((item as Record<string, unknown>).amount)) throw new Error("Invalid Meta cost result")
    const amount = (item as Record<string, unknown>).amount as Record<string, unknown>
    if (amount.currency !== "usd") throw new Error("Unsupported Meta cost currency")
    return number(amount.value, "amount.value")
  })
  return { start, cost: costs.length === 0 ? undefined : sum(costs, (cost) => cost) }
}

function window(id: string, label: string, unit: ProviderUsage.Unit, used: number) {
  return new ProviderUsage.Window({ id, label, unit, used })
}
function sum<T>(values: ReadonlyArray<T>, select: (v: T) => number) {
  return values.reduce((total, v) => total + select(v), 0)
}
function sumOptional<T>(values: ReadonlyArray<T>, select: (v: T) => number | undefined) {
  return values.reduce<number | undefined>((total, v) => {
    const value = select(v)
    if (value === undefined) return total
    return (total ?? 0) + value
  }, undefined)
}
function nextBillDueAt(monthStart: number) {
  if (!Number.isInteger(monthStart) || monthStart < 0) return undefined
  const start = new Date(monthStart * 1000)
  if (
    !Number.isFinite(start.getTime()) ||
    start.getUTCDate() !== 1 ||
    start.getUTCHours() !== 0 ||
    start.getUTCMinutes() !== 0 ||
    start.getUTCSeconds() !== 0 ||
    start.getUTCMilliseconds() !== 0
  )
    return undefined
  return Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1)
}
function timestamp(v: unknown, field: string) {
  return Math.trunc(number(v, field))
}
function number(v: unknown, field: string) {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new Error(`Invalid Meta usage response: ${field}`)
  return v
}
function record(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}
