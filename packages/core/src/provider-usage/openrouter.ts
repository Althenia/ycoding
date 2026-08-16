export * as OpenRouterUsage from "./openrouter"

import { ProviderUsage } from "@ycoding-ai/schema/provider-usage"
import { ProviderV2 } from "../provider"

interface KeyData {
  readonly usage?: unknown
  readonly usage_daily?: unknown
  readonly usage_weekly?: unknown
  readonly usage_monthly?: unknown
  readonly limit?: unknown
  readonly limit_remaining?: unknown
}

interface CreditsData {
  readonly total_credits?: unknown
  readonly total_usage?: unknown
}

export interface NormalizeKeyInput {
  readonly providerID: ProviderV2.ID
  readonly label: string
  readonly updatedAt: number
  readonly response: unknown
}

export function normalizeKey(input: NormalizeKeyInput) {
  const data = keyData(input.response)
  const usage = amount(data.usage, "usage", true) ?? 0
  const limit = amount(data.limit, "limit", false)
  const remaining = amount(data.limit_remaining, "limit_remaining", false)
  return new ProviderUsage.Snapshot({
    providerID: input.providerID,
    label: input.label,
    status: "available",
    source: "provider_api",
    stability: "stable",
    updatedAt: Math.max(0, Math.trunc(input.updatedAt)),
    windows: [
      new ProviderUsage.Window({
        id: "key",
        label: "Key limit",
        unit: "usd",
        used: usage,
        ...(limit === undefined ? {} : { limit }),
        ...(remaining === undefined ? {} : { remaining }),
      }),
      ...window("daily", "Daily", data.usage_daily),
      ...window("weekly", "Weekly", data.usage_weekly),
      ...window("monthly", "Monthly", data.usage_monthly),
    ],
  })
}

export function mergeCredits(snapshot: ProviderUsage.Snapshot, response: unknown) {
  const data = creditsData(response)
  const limit = amount(data.total_credits, "total_credits", true) ?? 0
  const used = amount(data.total_usage, "total_usage", true) ?? 0
  return new ProviderUsage.Snapshot({
    providerID: snapshot.providerID,
    label: snapshot.label,
    status: snapshot.status,
    source: snapshot.source,
    stability: snapshot.stability,
    updatedAt: snapshot.updatedAt,
    windows: [
      ...snapshot.windows,
      new ProviderUsage.Window({
        id: "credits",
        label: "Credits",
        unit: "usd",
        used,
        limit,
        remaining: Math.max(limit - used, 0),
      }),
    ],
    ...(snapshot.message === undefined ? {} : { message: snapshot.message }),
  })
}

function window(id: string, label: string, value: unknown) {
  const used = amount(value, id, false)
  return used === undefined ? [] : [new ProviderUsage.Window({ id, label, unit: "usd", used })]
}

function keyData(value: unknown): KeyData {
  const data = nestedData(value)
  for (const key of ["usage", "usage_daily", "usage_weekly", "usage_monthly", "limit", "limit_remaining"] as const)
    amount(data[key], key, key === "usage")
  return data
}

function creditsData(value: unknown): CreditsData {
  const data = nestedData(value)
  amount(data.total_credits, "total_credits", true)
  amount(data.total_usage, "total_usage", true)
  return data
}

function nestedData(value: unknown): Record<string, unknown> {
  if (!record(value) || !record(value.data)) throw new Error("Invalid OpenRouter usage response")
  return value.data
}

function amount(value: unknown, field: string, required: boolean) {
  if (value === undefined || value === null) {
    if (required) throw new Error(`Invalid OpenRouter usage response: ${field}`)
    return undefined
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw new Error(`Invalid OpenRouter usage response: ${field}`)
  return value
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
