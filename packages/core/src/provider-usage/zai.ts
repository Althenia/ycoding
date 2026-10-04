export * as ZAIUsage from "./zai"

import { ProviderUsage } from "@ycoding-ai/schema/provider-usage"
import { Provider } from "../provider"
import { Schema } from "effect"

const isRecord = Schema.is(Schema.Record(Schema.String, Schema.Unknown))

export function normalize(input: {
  readonly providerID: Provider.ID
  readonly label: string
  readonly updatedAt: number
  readonly quota: unknown
  readonly subscription?: unknown
}) {
  const root = record(input.quota)
  const data = record(root?.data ?? root)
  if (!Array.isArray(data?.limits)) throw new Error("Invalid Z.ai usage response")
  const entries = data.limits.map(record)
  const windows = entries.flatMap((entry) => {
    if (!entry) throw new Error("Invalid Z.ai usage response")
    const type = entry.type ?? entry.name
    if (type === "CREDIT_LIMIT" || type === "TOKENS_LIMIT") {
      const unit = number(entry.unit)
      const count = number(entry.number)
      if (count <= 0) throw new Error("Invalid Z.ai usage response")
      const seconds = unit === 3 ? 3600 * count : unit === 4 ? 86400 * count : unit === 6 ? 604800 * count : undefined
      if (seconds === undefined) return []
      return [new ProviderUsage.Window({
        id: seconds < 86400 ? "session" : "weekly",
        label: seconds < 86400 ? "Session" : "Weekly",
        unit: "percent", used: Math.min(100, number(entry.percentage)), periodSeconds: seconds,
        ...(entry.nextResetTime === undefined ? {} : { resetAt: number(entry.nextResetTime) }),
      })]
    }
    if (type !== "TIME_LIMIT") return []
    return [new ProviderUsage.Window({
      id: "web-searches", label: "Web Searches", unit: "count",
      used: number(entry.currentValue), limit: number(entry.usage),
      ...(entry.nextResetTime === undefined ? {} : { resetAt: number(entry.nextResetTime) }),
    })]
  })
  const subscription = record(input.subscription)
  const first = Array.isArray(subscription?.data) ? record(subscription.data[0]) : undefined
  const plan = typeof first?.productName === "string" ? first.productName.trim() : ""
  return new ProviderUsage.Snapshot({
    providerID: input.providerID, label: plan ? `${input.label} ${plan}` : input.label,
    status: "available", source: "provider_internal_api", stability: "best_effort",
    updatedAt: Math.max(0, Math.trunc(input.updatedAt)), windows,
  })
}

function number(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw new Error("Invalid Z.ai usage response")
  return value
}

function record(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}
