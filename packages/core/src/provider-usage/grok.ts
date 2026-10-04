export * as GrokUsage from "./grok"

import { ProviderUsage } from "@ycoding-ai/schema/provider-usage"
import { Provider } from "../provider"
import { Schema } from "effect"

const isRecord = Schema.is(Schema.Record(Schema.String, Schema.Unknown))

export function normalize(input: {
  readonly providerID: Provider.ID
  readonly label: string
  readonly updatedAt: number
  readonly response: unknown
}) {
  const root = record(input.response)
  const config = record(root?.config)
  const period = record(config?.currentPeriod)
  const start = typeof period?.start === "string" ? Date.parse(period.start) : NaN
  const end = typeof period?.end === "string" ? Date.parse(period.end) : NaN
  if (typeof period?.type !== "string" || !Number.isFinite(start) || !Number.isFinite(end) || end <= start)
    throw new Error("Invalid Grok usage response")
  const used = nonNegative(config?.creditUsagePercent === undefined ? 0 : config.creditUsagePercent)
  const capValue = config?.onDemandCap
  const capObject = record(capValue)
  if (capValue !== undefined && !capObject) throw new Error("Invalid Grok usage response")
  const cap = capObject ? nonNegative(capObject.val === undefined ? 0 : capObject.val) : 0
  return new ProviderUsage.Snapshot({
    providerID: input.providerID,
    label: input.label,
    status: "available",
    source: "provider_internal_api",
    stability: "best_effort",
    updatedAt: Math.max(0, Math.trunc(input.updatedAt)),
    windows: [
      ...(period.type === "USAGE_PERIOD_TYPE_WEEKLY" ? [new ProviderUsage.Window({
        id: "weekly", label: "Weekly", unit: "percent", used: Math.min(100, used),
        resetAt: end, periodSeconds: Math.floor((end - start) / 1000),
      })] : []),
      new ProviderUsage.Window({ id: "extra-usage", label: "Extra usage", unit: "count", limit: cap }),
    ],
  })
}

function nonNegative(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw new Error("Invalid Grok usage response")
  return value
}

function record(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}
